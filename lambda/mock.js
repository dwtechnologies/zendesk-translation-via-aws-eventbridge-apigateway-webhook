const agentIntNoteEvent = require('../events/agent_internal_note.json');
const custCommEvent = require('../events/customer_comment.json');
const AWS = require('aws-sdk');

AWS.config.loadFromPath('../config/credentials.json');

function getTestEvent(id) {
    return custCommEvent;
}

module.exports = {
    getTestEvent: getTestEvent
}