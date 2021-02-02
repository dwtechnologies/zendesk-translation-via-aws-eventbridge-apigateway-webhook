Webhook Configuration Guide

1. Set up the properties in the Makefile and the parameters files.

Pay attantion that SERVICE_NAME should not be too long because it's used as prefix of 
the event bus rule name. That isn't allowed to be more than 100 characters.

The example of the webhook parameters:

BasicAuthUsernameSSMParameterPath=/config/zendesk-translation/basicauth_username
BasicAuthPasswordSSMParameterPath=/config/zendesk-translation/basicauth_password
must be kms protected with a kms key

2. Build the lambdas and deploy the CloudFormation stack.

$ make deploy

3. Set up the values for parameters BasicAuthUsernameSSMParameterPath and BasicAuthPasswordSSMParameterPath

It can be done via System Manager / Parameter Store

4. Set up Zendeks HTTP Target

- Go to the Zendesk Admin panel / Extensions / 

- Click 'add target'

    - Choose 'HTTP Target'

    - Fill Title

    - Put URL of the POST method of API Gateway in the Url field (API Gateway/<API>/Stages/<Click on POST method of the stage>/Invoke URL)

    - Choose POST method

    - Enable Basic Authentication, set Username and Password values (The values must be the same as in Parameter Store)

    - Choose Create target and press Submit

- Go to Triggers, we will create two of them.

- Click 'Add trigger'
    
    - Fill Trigger name, eg Zendesk translation external customer

    - Under condition Meet ALL of the following conditions, add the following
      	- Comment is public
    	- Role is (end-user)
	- Channel is not Web service (API)

    - In Actions section choose Notify target, choose the created HTTP target

    - In JSON body insert content of zendesk/trigger_msg_tmpl.json file

    - Press Save 

- Click 'Add trigger'

    - Fill Trigger name, eg Zendesk translation internal translate note

    - Under condition Meet ALL of the following conditions, add the following
        - Comment is private 
        - Channel is not Web service (API)
	- Comment text Contains the following string #translate

    - In Actions section choose Notify target, choose the created HTTP target

    - In JSON body insert content of zendesk/trigger_msg_tmpl.json file

    - Press Save

