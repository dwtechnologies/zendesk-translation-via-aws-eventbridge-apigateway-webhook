const AWS = require('aws-sdk');
const translate = new AWS.Translate({apiVersion: '2017-07-01'});
const axios = require('axios');
const ssm = new AWS.SSM();
const LanguageDetect = require('languagedetect');
const lngDetector = new LanguageDetect();
const fs = require('fs');
const util = require('util');
const stream = require('stream');
// It's to use Node.js stream pipeline in async functions
const pipeline = util.promisify(stream.pipeline);

// Enable debug mode. Mostly it's used for logging debug messages
const isDebugMode = process.env.DEBUG === 'true';

// Config object
const config = {
    "ZENDESK": {
        "SUBDOMAIN": process.env.ZENDESK_SUBDOMAIN,
        "EMAIL": process.env.ZENDESK_EMAIL,
        // Access token created in the Zendesk API settings
        "ACCESS_TOKEN_PARAM_KEY": process.env.ZENDESK_ACCESS_TOKEN_PARAM_KEY,
        // ID of the field created for Ticket language 
        // It's configured in the Zendesk Ticket Fields section
        "TICKET_LANG_FIELD_ID": parseInt(process.env.ZENDESK_TICKET_LANG_FIELD_ID, 10)
    }
};

// Special function to write debug messages if debug mode is enabled
console.debug = function() {
    if (isDebugMode) {
        console.log.apply(console, arguments);
    }
}

console.debug(process.env.ZENDESK_EMAIL, config.ZENDESK.EMAIL);

// Code that is used as source & target language code for AWS Translate
const AWS_TRANSLATE_DEFAULT_TARGET_LANG = 'en';
// Zendesk API URLs templates
const ZENDESK_CREATE_COMM_URL_TMPL =
    'https://{subdomain}.zendesk.com/api/v2/tickets/{id}.json';
const ZENDESK_UPDATE_TICKET_URL_TMPL =
    'https://{subdomain}.zendesk.com/api/v2/tickets/{id}.json';
const ZENDESK_SHOW_TICKET_URL_TMPL =
    'https://{subdomain}.zendesk.com/api/v2/tickets/{id}.json';
const ZENDESK_UPLOADS_URL_TMPL = 
    'https://{subdomain}.zendesk.com/api/v2/uploads.json';
const ZENDESK_LIST_COMM_URL_TMPL = 
    'https://{subdomain}.zendesk.com/api/v2/tickets/{ticket_id}/comments.json';
// marker to detect comment for translation
const TRANSLATE_CMD_MARK = '#translate';


/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html 
 * @param {Object} context
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object in API Gateway Lambda Proxy Output Format
 * 
 * This handler has async flag because AWS Translate API SDK is asynchronous
 * and this flag allows to execute this synchronously with await flag. 
 * It's implemented so that the code would be more easier to understand.
 * Execution time of this lambda can be reduced 
 * if use the practices described in the documentation: 
 * https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html
 * https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
 */
exports.lambdaHandler = async (event, context, callback) => {
    //let response;
    try {
        console.debug('version', 15);
        console.debug('event', event);
        // set two-letters language format
        lngDetector.setLanguageType('iso2');
        const zendeskToken = await getZendeskAccessToken();
        await handleZendeskEvent(event, zendeskToken, context);
        console.debug('lambda execution finished.');
    } catch (err) {
        console.error('event', event);
        if (err.data && err.data.Error) {
            console.error(err.data.Error);
        } else {
            console.error(err);
        }
    }
};

/**
 * Handle Zendesk event
 * 
 * Zendesk webhooks doc: https://support.zendesk.com/hc/en-us/articles/204890268-Creating-webhooks-with-the-HTTP-target
 * @param {Object} event - event in the Zendesk format. 
 *                         It's configured in Zendesk Triggers section and Amazon API Gateway 
 *                         \ Resources \ <HTTP method> \ Integration Request \ Mapping Templates
 *
 * @param {String} zendeskToken - Zendesk token configured in the Zendesk API section 
 */
async function handleZendeskEvent(event, zendeskToken) {
    
    if (!(event && event.detail && event.detail.ticket_event)) {
        throw new Error('Incorrect event');
    }

    const ticketEvent = event.detail.ticket_event;
    const ticket = ticketEvent.ticket;
    const ticketId = ticket.id;
    console.info(`Ticket ID: ${ticketId}`);
    const newComment = ticketEvent.comment;
    if (newComment) {
        console.info(`Comment ID: ${newComment.id}`);
        if (newComment.is_public == "true") {
            await handleZendeskCommentEvent(ticket, newComment,
                zendeskToken);
        } else {
            await handleZendeskIntNoteEvent(ticket, newComment,
                zendeskToken);
        }
    } else {
        console.warn(`The event for ticket ${''
            }doesn't contain any items to handle`);
    }
}

/**
 * Handle Zendesk internal note event
 *
 * Zendesk ticket: https://developer.zendesk.com/rest_api/docs/support/tickets
 * @param {Object} ticket - Zendesk ticket
 *
 * Zendesk comment: https://developer.zendesk.com/rest_api/docs/support/ticket_comments
 * @param {Object} comment - Zendesk comment
 *
 * @param {String} zendeskToken - Zendesk token
 */
async function handleZendeskIntNoteEvent(ticket, comment, zendeskToken) {
    console.debug('handleZendeskIntNoteEvent');
    if (comment.body.prefix == TRANSLATE_CMD_MARK) {
        const trgLangCode = await getTicketLangCode(ticket, zendeskToken);
        if (trgLangCode && trgLangCode != AWS_TRANSLATE_DEFAULT_TARGET_LANG) {
            const fullComment =
                await fetchTicketComment(ticket.id, comment.id, zendeskToken);
            const normalizedHtmlBody = escapeHTML(fullComment.html_body.replace(
                    TRANSLATE_CMD_MARK, ''));
            console.debug('comment', fullComment.html_body);
            console.debug('normalized', normalizedHtmlBody)
            const translatedResp = await translateText(
                normalizedHtmlBody,
                AWS_TRANSLATE_DEFAULT_TARGET_LANG, trgLangCode);
            const translatedComment = {
                author_id: comment.author.id,
                html_body: translatedResp.TranslatedText,
                public: true
            };
            const attachments = fullComment.attachments;
            console.debug('attachments', attachments);
            if (attachments) {
                const tokens =
                    await downloadAndUploadAttachments(
                        comment.id, attachments, zendeskToken);
                if (tokens.length > 0) {
                    translatedComment['uploads'] = tokens;
                }
            }
            await createZendeskComment(
                ticket.id, translatedComment, zendeskToken);
        } else {
            console.debug('Translation language ', trgLangCode);
        }
    } else {
        console.debug('Internal note doesn\'t contain #translate');
    }
}

/**
 * Utility function to escape characters that aren't allowed for HTML
 */
const escapeHTML = str => str.replace(/[&<>'"]/g, 
  tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag]));

/**
 * The method fetches full ticket comment
 * 
 * There is the API method to fetch list of ticket comments in Zendesk 
 * This method gets the last comment by the ID
 *
 * @param {String} ticketId - Zendesk ticket ID
 *
 * @param {String} commentId - Zendesk comment ID
 *
 * @param {String} zendeskToken - Zendesk token
 *
 * @returns {Object} Zendesk comment
 */
async function fetchTicketComment(ticketId, commentId, zendeskToken) {
    console.debug('fetchTicketComment');
    const apiURL = ZENDESK_LIST_COMM_URL_TMPL
        .replace('{subdomain}', config.ZENDESK.SUBDOMAIN)
        .replace('{ticket_id}', ticketId);
    const comments = await fetchTicketComments(apiURL, zendeskToken);
    let comment;
    for (let i = 0; i < comments.length; i++) {
        if (comments[i].id == commentId) {
            comment = comments[i];
            break;
        }
    }
    if (!comment) {
        console.warn(`The comment wasn't found`);
    }
    return comment;
}

/**
 *
 * The function fetches ticket comments via Zendesk API
 * 
 * @param {String} apiURL - Zendesk API URL
 *
 * @param {String} zendeskToken - Zendesk token
 *
 * @returns {Object[]} Zendesk comments
 */
async function fetchTicketComments(apiURL, zendeskToken) {
    console.debug('apiURL', apiURL);
    const resp = await axios({
        method: 'GET',
        url: apiURL,
        params: {
            sort_order: 'desc'
        },
        auth: {
            username: config.ZENDESK.EMAIL + '/token',
            password: zendeskToken
        }
    });
    if (isDebugMode) {
        console.debug(resp.statusText);
    }
    let comments = resp.data.comments;
    return comments;
}

/**
 *
 * Download Zendesk comment's attachements and upload them 
 * for another comment
 * 
 * This method downloads the attachements and saves them as temp files on the Lambda storage.
 * Then it uploads the files to Zendesk and returns upload tokens that can be used to attach
 * the files to a comment.
 *
 * @param {String} commentId - Zendesk comment ID. It's used for temp file name only
 *
 * @param {Object} attachments - THe list of the Zendesk comment's attachments objects
 *
 * @param {String} zendeskToken - Zendesk token
 *
 * @returns {String[]} the list of the upload tokens
 */
async function downloadAndUploadAttachments(
    commentId, attachments, zendeskToken
) {
    const tokens = [];
    let filePath;
    let token;
    for (let i = 0; i < attachments.length; i++) {
        filePath =
            await downloadAttachment(commentId, attachments[i], zendeskToken);
        if (filePath) {
            token = await uploadFileToZendesk(
                attachments[i].file_name, filePath, zendeskToken);
            if (token) {
                tokens.push(token);
                fs.unlinkSync(filePath);
            }
        }
    }
    return tokens;
}


/**
 *
 * Download an attachement via Zendesk API
 *
 * Zendesk attachment: https://developer.zendesk.com/rest_api/docs/support/attachments
 * @param {Object} attachment - Zendesk attachment object
 *
 * @param {String} zendeskToken - Zendesk token
 *
 * @returns {String} a file path of a temp file
 */
async function downloadAttachment(commentId, attachment, zendeskToken) {
    console.debug('downloadAttachment');
    let filePath;
    try {
        console.info(`Downloading file ${attachment.file_name} ${''
            }for attachment ${attachment.id}...`);
        const resp = await axios({
            method: 'GET',
            url: attachment.content_url,
            responseType: 'stream',
            auth: {
                username: config.ZENDESK.EMAIL + '/token',
                password: zendeskToken
            }
        });
        filePath = 
            `/tmp/zendesk_comment_file_${commentId}_${attachment.id}`;
        await pipeline(resp.data, fs.createWriteStream(filePath));
        console.info(resp.statusText);
    } catch(e) {
        console.error(`Error on attachment ${attachment.id} downloading`, e);
    }
    return filePath;
}

/**
 *
 * Upload a temp file to Zendesk
 * 
 * @param {String} fileName - filename of a uploaded file
 *
 * @param {String} filePath - filepath of the temp file
 *
 * @param {String} zendeskToken - Zendesk token
 *
 * @returns {String} upload token
 */
async function uploadFileToZendesk(fileName, filePath, zendeskToken) {
    console.debug('uploadFileToZendesk');
    let result;
    try {
        console.info(`Uploading file ${fileName}...`);
        const apiURL = ZENDESK_UPLOADS_URL_TMPL
            .replace('{subdomain}', config.ZENDESK.SUBDOMAIN);
        console.debug('apiURL', apiURL);
        const resp = await axios({
            method: 'POST',
            url: apiURL,
            params: {
                filename: fileName
            },
            data: fs.readFileSync(filePath, (err, data) => {
                if (err) {
                    console.error(err);
                }
            }),
            headers: {
                'Content-Type': 'application/binary'
            },
            auth: {
                username: config.ZENDESK.EMAIL + '/token',
                password: zendeskToken
            }
        });
        console.info(resp.statusText);
        if (resp.status == 201) {
            result = resp.data.upload.token;
            console.debug('token', result);
        }
    } catch (e) {
        console.error(`Error on file ${fileName} uploading`, e);
    }
    return result;
}

/*
 *
 * Handle Zendesk public comment event
 *
 * Zendesk ticket: https://developer.zendesk.com/rest_api/docs/support/tickets
 * @param {Object} ticket - Zendesk ticket
 *
 * Zendesk comment: https://developer.zendesk.com/rest_api/docs/support/ticket_comments
 * @param {Object} comment - Zendesk comment
 * 
 * @param {String} zendeskToken - Zendesk token
 */
async function handleZendeskCommentEvent(ticket, comment, zendeskToken) {
    console.debug('handleZendeskCommentEvent');
    const detectRes = lngDetector.detect(comment.body.value, 1);
    console.debug('Language detection', detectRes);
    if (!detectRes || detectRes && (detectRes.length == 0
        || detectRes[0][0] != AWS_TRANSLATE_DEFAULT_TARGET_LANG)) {
        const translateResp = await translateText(
            comment.body.value, 'auto',
            AWS_TRANSLATE_DEFAULT_TARGET_LANG);
        if (translateResp && translateResp.SourceLanguageCode
            && translateResp.SourceLanguageCode
            != AWS_TRANSLATE_DEFAULT_TARGET_LANG) {
            const translatedComment = {
                author_id: comment.author.id,
                body: translateResp.TranslatedText,
                public: false
            };
            await setTicketLanguage(ticket.id,
                translateResp.SourceLanguageCode, zendeskToken);
            await createZendeskComment(
                ticket.id, translatedComment, zendeskToken);
        }
    }
}

/**
 * Create a comment via Zendesk API
 * 
 * @param {String} ticketId - Zendesk ticket ID
 *
 * @param {Object} comment - Zendesk comment object
 *
 * @param {String} zendeskToken - Zendesk token
 */
async function createZendeskComment(ticketId, comment, zendeskToken) {
    console.debug('createZendeskComment', comment);
    const apiURL = ZENDESK_CREATE_COMM_URL_TMPL
        .replace('{subdomain}', config.ZENDESK.SUBDOMAIN)
        .replace('{id}', ticketId);
    console.debug('apiURL', apiURL);
    const resp = await axios({
        method: 'PUT',
        url: apiURL,
        data: {
            ticket: {
                comment: comment
            }
        },
        auth: {
            username: config.ZENDESK.EMAIL + '/token',
            password: zendeskToken
        }
    });
    if (isDebugMode) {
        console.debug(resp.statusText);
    }
}

/**
 *
 * Translate text via AWS Translate API
 * 
 * @param {String} text - The text
 * 
 * @param {String} srcLangCode - Source language code
 *
 * @param {String} trgLangCode - Target language code
 *
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Translate.html#translateText-property
 * @returns {Object} AWS Translate result object
 */
async function translateText(text, srcLangCode, trgLangCode) {
    srcLangCode = srcLangCode || 'auto';
    console.info(`Translating text from ${srcLangCode} to ${trgLangCode}...`);
    const params = {
        SourceLanguageCode: srcLangCode,
        TargetLanguageCode: trgLangCode,
        Text: text
    };
    const resp = await translate.translateText(params).promise();
    if (resp.TranslatedText) {
        const rSrcLangCode = resp.SourceLanguageCode;
        const rTrgLangCode = resp.TargetLanguageCode;
        console.info(
            `Successfully translated from ${rSrcLangCode} to ${rTrgLangCode}`);
    }
    console.debug('Translated result', resp);
    return resp;
}

/**
 *
 * Get ticket language code
 * 
 * This function is forced to use Zendesk API to get 
 * the ticket language field value
 * 
 * @param {Object} ticketEvent - Zendesk event ticket object
 *
 * @param {String} zendeskToken - Zendesk token
 * 
 * @returns {String} the language code
 */
async function getTicketLangCode(ticketEvent, zendeskToken) {
    let result;
    const apiURL = ZENDESK_SHOW_TICKET_URL_TMPL
        .replace('{subdomain}', config.ZENDESK.SUBDOMAIN)
        .replace('{id}', ticketEvent.id);
    console.debug('apiURL', apiURL);
    const resp = await axios({
        method: 'GET',
        url: apiURL,
        auth: {
            username: config.ZENDESK.EMAIL + '/token',
            password: zendeskToken
        }
    });
    console.debug(resp.statusText);
    if (resp.status != 200) {
        throw new Error('Ticket data weren\'t fetched');
    }
    const custom_fields = resp.data.ticket.custom_fields;
    console.debug('custom_fields', custom_fields,
        config.ZENDESK.TICKET_LANG_FIELD_ID);
    if (custom_fields) {
        //let langTicket;
        for (let i = 0; i < custom_fields.length; i++) {
            console.debug('finding custom field', custom_fields[i].id);
            if (custom_fields[i].id == config.ZENDESK.TICKET_LANG_FIELD_ID) {
                result = custom_fields[i].value.substring(5); // lang-<code>
                console.debug('lang', result);
                break;
            }
        }
    }
    return result;
}

/**
 *
 * Set ticket language for the ticket
 *
 * The function set value of the ticket language field via Zendesk API
 *
 * @param {String} ticketId - Zendesk ticket ID
 *
 * @param {String} languageCode - the language code
 *
 * @param {String} zendeskToken - Zendesk token
 * 
 */
async function setTicketLanguage(ticketId, languageCode, zendeskToken) {
    console.debug('setTicketLanguage', languageCode);
    const apiURL = ZENDESK_UPDATE_TICKET_URL_TMPL
        .replace('{subdomain}', config.ZENDESK.SUBDOMAIN)
        .replace('{id}', ticketId);
    console.debug('apiURL', apiURL);
    const ticketLangField = {
        'id': config.ZENDESK.TICKET_LANG_FIELD_ID,
        'value': 'lang-' + languageCode
    };
    console.debug(ticketLangField);
    const resp = await axios({
        method: 'PUT',
        url: apiURL,
        data: {
            ticket: {
                custom_fields: [ ticketLangField ]
            }
        },
        auth: {
            username: config.ZENDESK.EMAIL + '/token',
            password: zendeskToken
        }
    });
    if (isDebugMode) {
        console.debug(resp.statusText);
    }
}

/**
 *
 * Get Zendesk access token via AWS Systems Manager API
 * 
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SSM.html#getParameter-property
 * @returns {String} the access token
 */
async function getZendeskAccessToken() {
    console.debug('getZendeskAccessToken',
        config.ZENDESK.ACCESS_TOKEN_PARAM_KEY);
    const resp = await ssm.getParameter({
            Name: config.ZENDESK.ACCESS_TOKEN_PARAM_KEY,
            WithDecryption: true
        }).promise();
    if (resp && resp.Parameter && resp.Parameter.Value) {
        return resp.Parameter.Value;
    } else {
        console.error(resp);
        throw new Error('Zendesk access token wasn\'t got');
    }
}

