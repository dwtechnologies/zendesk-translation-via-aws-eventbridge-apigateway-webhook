const AWS = require('aws-sdk');

const ssm = new AWS.SSM();

const isDebugMode = process.env.DEBUG === 'true';

const config = {
    'BASIC_AUTH_USERNAME_PARAM_KEY': process.env.BASIC_AUTH_USERNAME_PARAM_KEY,
    'BASIC_AUTH_PASSWORD_PARAM_KEY': process.env.BASIC_AUTH_PASSWORD_PARAM_KEY
};

console.debug = function() {
    if (isDebugMode) {
        console.log.apply(console, arguments);
    }
}

exports.lambdaHandler = async (event, context, callback) => {

    // console.log('event', event);
    
    const authHeader = event.headers.Authorization;
    
    if (!authHeader) {
        return callback('Unauthorized');
    }
    
    const encodedCredentials = authHeader.split(' ')[1];
    const credentials = 
        (Buffer.from(encodedCredentials, 'base64')).toString().split(':');
    const username = credentials[0];
    const password = credentials[1];

    const usernameResp = await ssm.getParameter({
            Name: config.BASIC_AUTH_USERNAME_PARAM_KEY
        }).promise();
        
    if (!(usernameResp && usernameResp.Parameter
        && usernameResp.Parameter.Value)) {
            
        console.error('Missing username value', usernameResp);
        return callback('Unauthorized');
    }

    //Get the basic auth password from ssm, expecting to be protected with kms
    const passwordResp = await ssm.getParameter({
            Name: config.BASIC_AUTH_PASSWORD_PARAM_KEY,
            WithDecryption: true
        }).promise();
        
    if (!(passwordResp && passwordResp.Parameter
        && passwordResp.Parameter.Value)) {
            
        console.error('Missing password value', passwordResp);
        return callback('Unauthorized');
    }

    const trueUsername = usernameResp.Parameter.Value;
    const truePassword = passwordResp.Parameter.Value;

    if (!(username === trueUsername && password === truePassword)) {
        return callback('Unauthorized');
    }
    
    const authResp = buildResponse(event, username);
    
    return callback(null, authResp);
}

function buildResponse(event, username) {
    
    const methodARNParts = event.methodArn.split(':');
    const apiPathParts = methodARNParts[5].split('/');
    const awsAccountId = methodARNParts[4];
    const awsRegion = methodARNParts[3];
    const apiId = apiPathParts[0];
    const apiStage = apiPathParts[1];
    const httpMethod = apiPathParts[2];
    const apiResource = apiPathParts[3];
    
    const apiArn = `arn:aws:execute-api:${awsRegion}:${awsAccountId}:${apiId}` +
        `/${apiStage}/${httpMethod}/${apiResource}`;

    const policy = {
        principalId: username,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [{
                Action: 'execute-api:Invoke',
                Effect: 'Allow',
                Resource: [apiArn]
            }]
        }
    };
    return policy;
}
