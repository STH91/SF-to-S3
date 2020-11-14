/*
This implementation borrows heavily from the work of Krishnan et al at AWS.
The original code and relevant licences can be found here: https://s3-us-west-2.amazonaws.com/awssfdcintegrationcode/PDF+version+of+CommentedSource_license.pdf
*/
const nforce = require('nforce');
const AWS = require('aws-sdk');
const https = require('follow-redirects').https;
// AWS details
const BUCKET_NAME = '<INSERT BUCKET NAME>';
const ACCESSKEYID = '<INSERT ACCESS KEY ID>';
const SECRETACCESSKEY = '<INSERT SECRET KEY>';
const AWS_REGION = '<INSERT REGION>';
const API_VERSION = '2006-03-01';
const US_EAST_1 = 'us-east-1';
// URL to be uploaded must contain the S3 AWS region
// If S3 and Lambda are in different regions, this is the case by default
const S3_URL = 'https://' + BUCKET_NAME + '.s3.';
const UPDATED_S3_URL = 'https://' + BUCKET_NAME + '.s3.' + AWS_REGION + '.';
// SF details
const USERNAME = '<INSERT USERNAME>';
const PASSWORD = '<INSERT PASSWORD>';
const SECURITY_TOKEN = '<INSERT SECURITY TOKEN>';
const CLIENT_ID = '<INSERT CLIENT ID>';
const CLIENT_SECRET = '<INSERT CLIENT SECRET>';
const REDIRECT_URI = 'http://localhost:3001/oauth/callback';
const INSTANCE_URL = '<INSERT INSTANCE URL>';
AWS.config.update({accessKeyId: ACCESSKEYID, secretAccessKey: SECRETACCESSKEY, region: AWS_REGION });
var s3 = new AWS.S3({apiVersion: API_VERSION});
var url_index = 0; // Indexer to allow for uploading multiple images

var org = nforce.createConnection({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI, // http://localhost:3001/oauth/callback
    mode: 'single'
   });
   
exports.handler = function(event, context, callback){
    org.authenticate({username: USERNAME, password: PASSWORD + SECURITY_TOKEN }, function(error, oauth) {
        if(error) { return console.log('Error authenticating to Salesforce, ' + error); }
        
        // Collect Product ID from event object
        var Id = event.Id;
        
        // Using the ID of the Product2 object, to obtain the attached files
        var queryProducts = 'SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = \'' + Id + '\'';        
        var resultProducts;
        querySFDC(queryProducts).then( result => {
            resultProducts = result;
            for(let i = 0; i < resultProducts.length; i++){
                var ContentDocumentId = resultProducts[i].get('ContentDocumentId');
                // Get the binary data of the attached files
                var queryAttachments = 'SELECT Title, FileType, VersionData FROM ContentVersion WHERE ContentDocumentId = \'' + ContentDocumentId + '\'';
                querySFDC(queryAttachments).then( result => {
                    var resultAttachment = result;
                    var title = resultAttachment[0].get('Title');
                    var updatedTitle = title.replace(/\s/g, '');   // Remove whitespace from file name for Baby Safe app
                    var fileType = resultAttachment[0].get('FileType');
                    fileType = fileType.toLowerCase();
                    if(fileType == 'jpg'){ 
                        fileType = 'jpeg'; // jpg doesn't work for iOS
                    }
                    var url = resultAttachment[0].get('VersionData');
                    console.log('Answer: ' + resultAttachment[0].get('VersionData'));
                    // Upload the retrieved binary stream to an S3 bucket
                    sendToS3(updatedTitle, fileType, url).then( result => {
                        // Take the returned S3 URL and update the Product2 object                        
                        if(AWS_REGION == US_EAST_1)
                        {
                            var url = result.Location;
                            var newurl = url.replace(S3_URL, UPDATED_S3_URL);
                        }
                        else { newurl = result.Location; }
                        uploadS3Path(fileType, newurl).then( result => {
                                console.log(result);
                        });
                });
        });
    }
        })
        .catch(error => {
            console.error(error);
        });

        // Updates custom URL fields on the Product2 object with a public S3 URL
        function uploadS3Path(filetype, s3url){
            return new Promise ( result => {
                var queryresult;
                var queryFileUpdate = 'SELECT Id, S3_Image__c, S3_Image_2__c, S3_Image_3__c, S3_PDF__c FROM Product2 WHERE Id = \'' + Id + '\'';
                querySFDC(queryFileUpdate).then( results => {
                if(result.length > 0) {
              
                    var acc = results[0];
                    var img_path = 'S3_Image__c';

                    // This implementation specifically uploads PDFs and/or images
                    // but can be adapted for other files types
                    if(filetype == 'pdf'){
                      acc.set('S3_PDF__c', s3url);
                    }
                    else{
                        if(url_index == 1){img_path = 'S3_Image_2__c';}
                        else if(url_index == 2){img_path = 'S3_Image_3__c';}
                        acc.set(img_path, s3url);
                        url_index++;
                    }
                    org.update({ sobject: acc }, function(err){
                        if(!err) 
                        { 
                            queryresult = 'Updated URL: ' + s3url; 
                            return result(queryresult); 
                        }
                    });
                } else { console.log('Query returned no results'); }
                    }).catch(error => {
                        console.log('Error: ', error.message);
                    });
            });            
        }

        // Uses a GET request to download a file from Salesforce
        // Then uploads it to a specified S3 bucket
        function sendToS3(title, filetype, url){
            return new Promise ( result => {
                var options = {
                    'method': 'GET',
                    'hostname': INSTANCE_URL,
                    'path': url,
                    'headers': {
                      'Authorization': 'Bearer ' + org.oauth.access_token,
                      'Content-Type': 'text/plain'
                    },
                    'maxRedirects': 20
                  };
                  var ContentType;
                  // This implementation specifically uploads PDFs and/or images
                    // but can be adapted for other files types                    
                    if(filetype == 'pdf'){
                        ContentType = 'application/pdf';
                    } else { ContentType = 'image/' + filetype; }
                  var req = https.request(options, function (res) {
                    var chunks = [];
                  
                    res.on("data", function (chunk) {
                      chunks.push(chunk);
                    });
                  
                    res.on("end", function (chunk) {
                      var body = Buffer.concat(chunks);
                      var params = {
                          Body: body,
                          Bucket: BUCKET_NAME, 
                          Key: title + '/' + title + '.' + filetype,
                          ContentType: ContentType,
                          ACL: "public-read" // Makes S3 file publically accessible
                          };
                          s3.upload(params, function(err, data) {
                              if (err) console.log(err, err.stack);
                              else result(data);
                          });    
                    });              
                    res.on("error", function (error) {
                      console.error(error);
                    });
                  });
                  req.end();
            });            
        }

        // Function that performs a SOQL query and returns the result
        // Uses the nforce library
        function querySFDC(query) {
            return new Promise( result => {
                var queryresult;
                console.log("Query Running: " + query);
                org.query({ query: query }).then( results => {
                    if (results.records.length > 0) {
                        queryresult = results.records;
                    } else {
                        console.log("There are no attachments");
                    }
                result(queryresult);
            });            
            });
        }
});
        };