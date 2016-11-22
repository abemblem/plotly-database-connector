import { combineReducers } from 'redux';
import {assoc, assocPath, merge, dissoc} from 'ramda';


/*
{
    // If tabs map to saved credentials, then that mapping is stored here.
    // If tabs aren't yet saved, then they won't be in this map.
    // Tab IDs and Credential IDs are used to index parts of the store below.
    tabMap: {
        [tabid1]: [credentialId1]
    },

    selectedTab: tabid1,
    selectedTable: {
        [tabid1]: 'my-table'
    }

    // Local store of the credentials.
    // Preloaded with the response from credentialsRequest
    credentials: {
        [tabid1]: {
            username: 'chris',
            [...]
        }
    }

    // API Requests that just hold the status and the content
    credentialsRequests: {
        statusCode: 200,
        content: [
            {

            }
        ]
    },

    connectRequests: {
        [credentialId]: {
            statusCode: 200
        }
    },

    saveCredentialsRequests: {
        [tabid1]: {
            statusCode: 200
        }
    }

    tablesRequests: {
        [credentialId1]: {
            status: 200,
            content: ['table1', 'table2', ...]
        }
    },

    getElasticsearchMappingsRequests: {
        [credentialId1]: {
            status: 200,
            content: {index1: {}, index2: {}}
        }
    },

    previewTableRequests: {
        [credentialId1]: {
            status: 200,
            content: ...
        }
    },

    s3KeysRequests: {
        [credentialId]: {
            status: 200,
            content: [...]
        }
    }

    apacheDrillStorageRequests: {
        [credentialId]: {
            status: 200,
            content: [...]
        }
    }

}
*/


function createApiReducer(store) {
    return function ApiReducer(state = {}, action) {
        let newState = state;
        if (action.type === store) {
            const {payload} = action;
            if (Array.isArray(payload.id)) {
                newState = assocPath(payload.id, {
                    status: payload.status,
                    content: payload.content
                }, state);
            } else if (payload.id) {
                newState = assoc(payload.id, {
                    status: payload.status,
                    content: payload.content
                }, state);
            } else {
                newState = merge(
                    state,
                    {status: payload.status, content: payload.content}
                );
            }
        }
        return newState;
    };
}
export const connectRequests = createApiReducer('connectRequests');
export const credentialsRequest = createApiReducer('credentialsRequest');
export const hasCertsRequest = createApiReducer('hasCertsRequest');
export const createCertsRequest = createApiReducer('createCertsRequest');
export const saveCredentialsRequests = createApiReducer('saveCredentialsRequests');
export const deleteCredentialsRequests = createApiReducer('deleteCredentialsRequests');
export const tablesRequests = createApiReducer('tables');
export const elasticsearchMappingsRequests = createApiReducer('elasticsearchMappingsRequests');
export const previewTableRequests = createApiReducer('previewTableRequest');
export const s3KeysRequests = createApiReducer('s3KeysRequests');
export const apacheDrillStorageRequests = createApiReducer('apacheDrillStorageRequests');
export const apacheDrillS3KeysRequests = createApiReducer('apacheDrillS3KeysRequests');


function tabMap(state = {}, action) {
    let newState = state;
    if (action.type === 'MERGE_TAB_MAP') {
        newState = merge(state, action.payload);
    }
    return newState;
}

function selectedTab(state = '', action) {
    if (action.type === 'SET_TAB') {
        return action.payload;
    } else {
        return state;
    }
}

function selectedTables(state = {}, action) {
    if (action.type === 'SET_TABLE') {
        return merge(state, action.payload);
    } else {
        return state;
    }
}

function selectedIndecies(state = {}, action) {
    if (action.type === 'SET_INDEX') {
        return merge(state, action.payload);
    } else {
        return state;
    }
}

function credentials(state = {}, action) {
    if (action.type === 'MERGE_CREDENTIALS') {
        return merge(state, action.payload);
    } else if (action.type === 'UPDATE_CREDENTIAL') {
        return assoc(
            action.payload.tableId,
            merge(
                state[action.payload.tableId],
                action.payload.update
            ),
            state
        );
    } else if (action.type === 'DELETE_CREDENTIAL') {
        return dissoc(action.payload, state);
    } else {
        return state;
    }
}

const rootReducer = combineReducers({
    tabMap,
    credentials,
    hasCertsRequest,
    createCertsRequest,
    selectedTab,
    selectedTables,
    selectedIndecies,
    connectRequests,
    credentialsRequest,
    saveCredentialsRequests,
    deleteCredentialsRequests,
    tablesRequests,
    elasticsearchMappingsRequests,
    previewTableRequests,
    s3KeysRequests,
    apacheDrillStorageRequests,
    apacheDrillS3KeysRequests
});

export default rootReducer;
