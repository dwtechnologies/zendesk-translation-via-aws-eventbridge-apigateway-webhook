
ENVIRONMENT        ?= dev
PROJECT            =  wh-zendesk-trans
OWNER		   = "Customer service"
#stay with the same length of SERVICE_NAME as it expands and messes up eventbridge rules (max length 100)
SERVICE_NAME       =  wh-zendesk-trans
ARTIFACTS_BUCKET   =  your-artifactory-bucket-$(ENVIRONMENT)
ARTIFACTS_PREFIX   := $(PROJECT)/$(SERVICE_NAME)
AWS_DEFAULT_REGION ?= eu-west-1
AWS_PROFILE ?= your-aws-cli-profile


sam_package = aws --profile $(AWS_PROFILE) cloudformation package \
                --template-file template.yaml \
                --output-template-file template_out.yaml \
                --s3-bucket $(ARTIFACTS_BUCKET) \
		--s3-prefix $(ARTIFACTS_PREFIX) 

sam_deploy = aws --profile $(AWS_PROFILE) cloudformation deploy \
                --template-file template_out.yaml \
		--parameter-overrides \
			$(shell cat parameters-$(ENVIRONMENT).env) \
		--stack-name $(SERVICE_NAME)-$(ENVIRONMENT) \
		--region $(AWS_DEFAULT_REGION) \
                --capabilities CAPABILITY_IAM \
                --tags \
                        Environment=$(ENVIRONMENT) \
                        Project=$(PROJECT) \
			Owner=$(OWNER) \
                --no-fail-on-empty-changeset 

deploy:
	cd lambda && npm install
	$(call sam_package)
	$(call sam_deploy)
	@rm -rf template_out.yaml

clean:
	@rm -rf template_out.yaml


