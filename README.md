Overview
========
This worker code creates a simple HTTP endpoint for sending emails via the GMail API.

It uses an OAuth flow to establish who is sending the emails.  Emails can be sent from
any 'from' address providing the user is authorised to do so.

Once the OAuth flow has been completed by navigating to /setup, the resulting token is stored
in R2. Another token cannot be created without deleting the existing one from R2 manually.

When the Google acess token expires (after 1 hour?), the refresh token is automatically
used to create a new access token.

The route /send accepts a JSON structure containing the email details. A password
defined as a worker secret must be provided in an Authorisation header for the email
to be sent.

The JSON body delivered to the /send route needs to be in the following format:  
```JSON
    {  
    	"messageID": "123456789",					//optional  
    	"from": "your_email@yourdomain.com",  
    	"to": "recipient@somedomain.com",				  
    	"cc": "someotheremail@somedomain.com",		//optional  
    	"bcc": "someotheremail2@somedomain.com", 	//optional  
    	"subject": "email subject",					//optional?  
    	"body": "plain text email body",			//required if no bodyHTML  
    	"bodyHTML": "<b>HTML</b> body version",		//required if no body  
    	"attachments": [							//optional  
    		{
    			"contentType": "image/png", 		//required  
    			"filename": "myimage.png",			//required  
    			"body": "iVBORw0KGgo....",			//required, base64 encoded  
    		},  
    	]  
    }  
```

The worker uses minimal dependencies: itty-router and mimemessage.
Mimemessage is used to construct an appropriate MIME body conforming to the RFC822
specification. Currently plain/HTML emails are working with attachments. At least one
of plain/HTML bodies must be included in the /send payload.

A basic test form exists at /test which includes the logic for adding the Authorization
header and other supported fields including sending an attachment image.

Still To do
===========
- Add support for Reply-to header (assuming possible)
- Embedded attachment support
- Create a route (password protected) to delete existing the OAuth token from R2 so OAuth
process can be restarted

Prerequisites
=============
- Setup Wrangler and login to Wrangler.
- npm installed
- A Google project with OAuth credentials created.
Note: Project OAuth cedentials will include a Client ID and Client Secret. Once your worker
is published, you will also need to add the appropriate 'Authorized redirect URI' to your
OAuth setup.

Setup
======
- Clone this repository.
- Rename wrangler.toml.example to wrangler.toml
- Run "npm install" to install the dependencies
- Modify the wrangler.toml and add your GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI. The redirect
URI should end in /auth e.g. https://your-worker-url.dev/auth
- Create a secret using wranger called GOOGLE_CLIENT_SECRET using the flag --env=production.
- Create another secret using wrangler called PASSWORD using a value of your choice. Use the
flag --env=production
- If you intend to test locally create additional secrets without the --env=produciton flag.
- Create R2 buckets called 'cloudflare-gmail-send' and 'cloudflare-gmail-send-dev' If
you want to change the names of these, or use existing buckets, then modify wrangler.toml
- Publish the worker "wrangler publish --env production" or "npm start" to test locally.
- Setup the authorised redirect URI in your Google project to match the worker URI.
- Visit WORKER-URL/setup and complete the OAuth flow
- Visit WORKER-URL/test and use the example form to test sending emails.

Notes
=====
The GMail API seems to ignore the Message-ID header.
