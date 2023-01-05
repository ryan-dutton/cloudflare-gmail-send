import { Router } from 'itty-router';
import { factory as mime} from 'mimemessage';

const GMAIL_SCOPE = "https://mail.google.com/";

/*
	Redirects to Google OAuth flow requesting 'gmail' scope
*/
const setup = (request, env, context) => {
	var gmail_consent_url = "https://accounts.google.com/o/oauth2/v2/auth?"+
	"client_id="+env.GOOGLE_CLIENT_ID+	// provided by Google when you setup OAuth credentials on a project
	"&redirect_uri="+env.GOOGLE_REDIRECT_URI+ // provided by you to Google when you setup OAuth credentials on a project. Should be https://your-worker-domain/auth
	"&scope="+GMAIL_SCOPE+ // This could be changed to just a 'send' scope
	"&response_type=code" + // Requests that an Oauth code is returned, which can then be exchanged for a refresh and access token
	"&access_type=offline" + // ensures a refresh_token is provided
	"&prompt=consent"; // ensures consent is requested very time, even if already authed. Wihthout this, only the access token is provided unless you revoke the authorisation here => 
	return Response.redirect(gmail_consent_url, 302);
}

/*
	This is the end-point the user is returned to after completing the OAuth flow.
	If successful an OAuth code is provided to be exchanged for an access and refresh
	token combo.
*/
const auth = async (request, env, context) => {
	//check if the token already exists in R2
	let current_token = await env.r2.get(env.TOKEN_FILENAME);
	if (current_token) {
		return new Response(`Error: token already exists.`, {status: 400});
	}
	//code and scope are provided as URL params
	const { searchParams } = new URL(request.url)
	const code = searchParams.get('code');
	const scope = searchParams.get('scope');
	if (code && scope === GMAIL_SCOPE) {
		//request the access and refresh tokens
		const response = await fetch("https://accounts.google.com/o/oauth2/token", {
			body:
				"code="+code+ //send code back to Google
				"&client_id="+env.GOOGLE_CLIENT_ID+ // with client_id, client_secret etc 
				"&client_secret="+env.GOOGLE_CLIENT_SECRET+
				"&grant_type=authorization_code"+
				"&redirect_uri="+env.GOOGLE_REDIRECT_URI,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			},
			method: "POST"
		});
		var token = await response.json();
		if (token.error) {
			return new Response(`Error: could not retrieve token with code: ${code} and redirect URI ${env.GOOGLE_REDIRECT_URI}, ClientID ${env.GOOGLE_CLIENT_ID}:`, {status: 400});
		}
		// token appears to be valid, store in R2
		await env.r2.put(env.TOKEN_FILENAME, JSON.stringify(token, null, 4));
		return new Response(`Code exchanged for access token, token saved.<br/><a href="/test">Test email form</a>`, {headers:{"content-type":"text/html"},status: 200});
	}
	return new Response(`Error: missing code and/or scope invalid.`, {status: 400});
}

/*
	This is needed to refresh the access_token when it expires.
*/
const _refresh = async (env) => {
	const current_token = await (await env.r2.get(env.TOKEN_FILENAME)).json();
	const response = await fetch("https://accounts.google.com/o/oauth2/token", {
		body:
			"client_id="+env.GOOGLE_CLIENT_ID+
			"&client_secret="+env.GOOGLE_CLIENT_SECRET+
			"&refresh_token="+current_token.refresh_token+
			"&grant_type=refresh_token",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded"
		},
		method: "POST"
	});
	var token = await response.json();
	if (token.access_token) {
		/* store the new token */
		await env.r2.put(env.TOKEN_FILENAME, JSON.stringify({
				...token,
				refresh_token: current_token.refresh_token // retain the refresh_token since it's NOT provided on refresh
			},null, 4));
		return token;
	} 
	return false;
}

/*
	Abstracted 'send' API call to Google.
	Body is a rfc822 compliant MIME body
	Token is the current OAuth access_token
*/
const _send = async(body, token) => {
	return await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
		{
			method: "POST",
			body:body, 
			headers: {
				"Authorization":"Bearer "+token,
				"Accept":"application/json",
				"Content-Type": "message/rfc822"
			},
		}
	);
}

/*
	Accepts an email object and returns a rfc822 compliant MIME body
	email paramater example:
	{
		messageID: '123456789',						//optional
		from: 'your_email@yourdomain.com',
		to: 'recipient@somedomain.com',				
		cc: 'someotheremail@somedomain.com',		//optional
		bcc: 'someotheremail2@somedomain.com', 		//optional
		subject: 'email subject',					
		body: 'plain text email body',				//required if no bodyHTML
		bodyHTML: '<b>HTML</b> body version',		//required if no body
		attachments: [								//optional
			{
				contentType: 'image/png',
				filename: 'myimage.png',
				body: 'iVBORw0KGgoAAAANSUhEUgAAADIAAAA0CAYAAADIZmusAAAA....'
			},
		]
	}
*/
const _construct = (email) => {
	// Build the top-level multipart MIME message.
	var msg = mime({ contentType: 'multipart/mixed', body: []});
	msg.header('Message-ID', '<'+(email.messageID?email.messageID:Date.now())+'>');
	msg.header('From', email.from);
	msg.header('To', email.to);
	if (email.cc && email.cc !== "") { msg.header('Cc', email.cc); }
	if (email.bcc && email.bcc !== "") { msg.header('Bcc', email.bcc); }
	msg.header('Subject', email.subject||"");
	// Build the multipart/alternate MIME entity containing both the HTML and plain text entities.
	var alternateEntity = mime({ contentType: 'multipart/alternative', body: [] });
	//Need to structure MIME nesting according to whether plain/HTML body or both is provided
	if ((email.body && email.body !== "") && (email.bodyHTML && email.bodyHTML !== "")) {
		// SCENARIO: both plain and HTML bodies
		// Build the HTML MIME entity.
		var htmlEntity = mime({ contentType: 'text/html;charset=utf-8',	body: email.bodyHTML });
		// Build the plain text MIME entity.
		var plainEntity = mime({ body: email.body });
		// Build the related MIME entity.
		var relatedEntity = mime({ contentType: 'multipart/related', body: [] });
		// Add the HTML entity to the multipart/related entity.
		relatedEntity.body.push(htmlEntity);
		// Add both the related and plain text entities to the multipart/alternate entity.
		alternateEntity.body.push(plainEntity);
		alternateEntity.body.push(relatedEntity);
	} else {
		if (!email.bodyHTML || email.bodyHTML === "") {
			// SCENARIO: no HTML body, assume plain only
			// Build the plain text MIME entity.
			var plainEntity = mime({ body: email.body });
			// Add the plain text entity to the multipart/alternate entity.
			alternateEntity.body.push(plainEntity);
		} else {
			// SCENARIO: HTML body, no plain body
			// Build the HTML MIME entity.
			var htmlEntity = mime({ contentType: 'text/html;charset=utf-8',	body: email.bodyHTML });
			// Add the HTML entity to the multipart/alternate entity.
			alternateEntity.body.push(htmlEntity);
		}
	} 
	// Add the multipart/alternate entity to the top-level MIME message.
	msg.body.push(alternateEntity);
	// Add attachments
	if (email.attachments) {
		for (var i=0; i<email.attachments.length; i++) {
			// Build the attachment entity.
			var attachmentEntity = mime({
				contentType: email.attachments[i].contentType,
				contentTransferEncoding: 'base64',
				body: email.attachments[i].body,
			});
			attachmentEntity.header('Content-Disposition', 'attachment ;filename="'+email.attachments[i].filename+'"');
			msg.body.push(attachmentEntity);
		}
	}
	return msg.toString();
}

const send = async (request, env, context) => {
	try {
		
		const authorizationHeader = request.headers.get('Authorization');
		if (!authorizationHeader) {
			return new Response(JSON.stringify({message:"Authorization header missing."}), {status: 401, headers: {"content-type":"application/json"}});
		} else {
			const password = request.headers.get('Authorization').replace("Bearer ","");
			if (env.PASSWORD !== password) {
				return new Response(JSON.stringify({message:"Supplied password in Auth header DNE secret PASSWORD."}), {status: 401, headers: {"content-type":"application/json"}});
			}
		}
		
		const email = await request.json();
		const token = await (await env.r2.get(env.TOKEN_FILENAME)).json();
		const mime = _construct(email);
		var response = await (await _send(mime, token.access_token)).json();
		if (response.error && response.error.status === "UNAUTHENTICATED") {
			const token_refreshed = await _refresh(env);
			if (!token_refreshed) {
				return new Response(JSON.stringify({message:"Could not refresh token"}), {status: 500, headers: {"content-type":"application/json"}});
			}
			response = await (await _send(mime, token_refreshed.access_token)).json();
		}
		return new Response(JSON.stringify(response), {status: 200, headers: {"content-type":"application/json"}});
	} catch (e) {
		return new Response(JSON.stringify({message:"Error sending email."+e.message}), {status: 500, headers: {"content-type":"application/json"}});
	}
}

/*
	Renders a simple HTML form to test the /send route
*/

const test = async (request, env, context) => {
	const form = `
<html>
	<body>
		<form>
			MessageID<br/><input type="text" name="messageID"/><br/>
			To<br/><input type="text" name="to"/><br/>
			CC<br/><input type="text" name="cc"/><br/>
			BCC<br/><input type="text" name="bcc"/><br/>
			From<br/><input type="text" name="from"/><br/>
			Subject<br/><input type="text" name="subject"/><br/>
			Body (plain text)<br/><textarea name="body"></textarea><br/>
			Body (HTML)<br/><textarea name="bodyHTML"></textarea><br/>
			Image Attachment<br/><input id="attachment" type="file" accept="image/png, image/gif, image/jpeg"/><br/>
			<input type="text" name="attachment_body" placeholder="base64 image body" readonly/>
			<input type="text" name="attachment_type" placeholder="image/png" readonly/>
			<input type="text" name="attachment_filename" placeholder="someimage.png" readonly/><br/>
			<img style="max-width: 150px;display: none;" id="preview"/><br/><br/>
			Password<br/><input type="password" name="password"/><br/>
			<button type="button" onclick="send(this.form);">Send</button>
		</form>
		<script>
			const convertBase64 = (file) => {
				return new Promise((resolve, reject) => {
					const fileReader = new FileReader();
					fileReader.readAsDataURL(file);
					fileReader.onload = () => {	resolve(fileReader.result);	};
					fileReader.onerror = (error) => { reject(error); };
				});
			};
			
			const uploadImage = async (event) => {
				const file = event.target.files[0];
				const form = event.target.form;
				const base64 = await convertBase64(file);
				form.attachment_filename.value = file.name;
				form.attachment_type.value = file.type;
				form.attachment_body.value = base64.split("base64,")[1]; //remove prefix
				document.getElementById("preview").src = base64;
				document.getElementById("preview").style.display = 'block';
			};
			
			document.getElementById("attachment").addEventListener("change", (e) => {
				uploadImage(e);
			});

			const send = async(f) => {
				document.getElementById("result").innerHTML = 'sending ..';
				var email = {
					to: f.to.value,
					from: f.from.value,
					subject: f.subject.value,
				}
				if (f.messageID.value != "") {	email = {...email, messageID: f.messageID.value} }
				if (f.cc.value != "") {	email = {...email, cc: f.cc.value} }
				if (f.bcc.value != "") { email = {...email, bcc: f.bcc.value} }
				if (f.bodyHTML.value != "") { email = {...email, bodyHTML: f.bodyHTML.value} }
				if (f.body.value != "") { email = {...email, body: f.body.value} }
				if (f.attachment_body.value != "") {
					email = {...email, attachments: [{
						contentType: f.attachment_type.value,
						filename: f.attachment_filename.value,
						body: f.attachment_body.value,
					}]}
				}
				const response = await fetch("/send", {
					body: JSON.stringify(email),
					headers: {
						"Content-Type": "application/json",
						"Authorization": "Bearer "+f.password.value,
					},
					method: "POST"
				});
				const response_json = await response.json();
				document.getElementById("result").innerHTML = JSON.stringify(response_json, null, 4);
			}
		</script>
		<xmp id="result"></xmp>
	</body>
</html>
`;
	return new Response(form, { headers: {
		"Content-Type": "text/html"
	}});
}

const router = Router();

router.get("/setup", setup);
router.get("/auth", auth);
router.get("/test", test);
router.post("/send", send);

router.all('*', (request, env) => {
	const message404 = `404 error - resource not found.<br/>Would you like to <a href="/setup">Setup OAuth</a> OR <a href="/test">Send a test email?</a>`;
	return new Response(message404, { headers: {"Content-type":"text/html"}, status: 404, })
});

export default {
	fetch: router.handle
}