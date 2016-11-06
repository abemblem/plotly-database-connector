import fetch from 'isomorphic-fetch';
import uuid from 'node-uuid';
import {createAction} from 'redux-actions';
import {DIALECTS} from '../constants/constants';

export const mergeTabMap = createAction('MERGE_TAB_MAP');
export const setTab = createAction('SET_TAB');
export const setTable = createAction('SET_TABLE');
export const mergeCredentials = createAction('MERGE_CREDENTIALS');
export const updateCredential = createAction('UPDATE_CREDENTIAL');
export const deleteCredential = createAction('DELETE_CREDENTIAL');


function GET(path) {
    /*
     * TODO - Need to template in 9000.
     * Can't just do a relative domain name because electron
     * loads up the app's HTML with loadFile which makes the base URL
     * of the app a filename not a URL.
     */
    return fetch(`http://localhost:9000/${path}`, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    });
}

function DELETE(path) {
    return fetch(`http://localhost:9000/${path}`, {
        method: 'DELETE',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    });
}

function POST(path, body = {}) {
    return fetch(`http://localhost:9000/${path}`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });
}
const request = {GET, POST, DELETE};


function apiThunk(endpoint, method, store, id, body) {
    return dispatch => {
        dispatch({
            type: store,
            payload: {id, status: 'loading'}
        });
        return request[method](endpoint, body)
        .then(res => res.json().then(
            json => {
                dispatch({
                    type: store,
                    payload: {
                        status: res.status,
                        content: json,
                        id
                    }
                });
                return json;
            }
        ))
        .catch(err => {
            console.error(err);
            dispatch({
                type: store,
                payload: {
                    id,
                    status: 500
                }
            });
        });
    };
}

export function getCredentials() {
    return apiThunk(
        'credentials',
        'GET',
        'credentialsRequest'
    );
}

export function connect(credentialId) {
    return apiThunk(
        `connect/${credentialId}`,
        'POST',
        'connectRequest',
        credentialId
    );
}

export function saveCredentials(credentialsObject, tabId) {
    return dispatch => {
        return dispatch(apiThunk(
            'credentials',
            'POST',
            'saveCredentialsRequest',
            tabId,
            credentialsObject
        )).then(json => {
            dispatch(mergeTabMap({[tabId]: json.credentialId}));
            return json;
        });
    };
}

export function getTables(credentialId) {
    return apiThunk(
        `tables/${credentialId}`,
        'POST',
        'tables',
        credentialId
    );
}

export function getS3Keys(credentialId) {
    return apiThunk(
        `s3-keys/${credentialId}`,
        'POST',
        's3KeysRequests',
        credentialId
    );
}

export function getApacheDrillStorage(credentialId) {
    return apiThunk(
        `apache-drill-storage/${credentialId}`,
        'POST',
        'apacheDrillStorageRequests',
        credentialId
    );
}

export function getApacheDrillS3Keys(credentialId) {
    return apiThunk(
        `apache-drill-s3-keys/${credentialId}`,
        'POST',
        'apacheDrillS3KeysRequests',
        credentialId
    );
}


function PREVIEW_QUERY (dialect, table, database = '') {
    switch (dialect) {
        case DIALECTS.MYSQL:
        case DIALECTS.SQLITE:
        case DIALECTS.MARIADB:
        case DIALECTS.POSTGRES:
            return `SELECT * FROM ${table} LIMIT 5`;
        case DIALECTS.MSSQL:
            return 'SELECT TOP 5 * FROM ' +
                `${database}.dbo.${table}`;
        default:
            throw new Error(`Dialect ${dialect} is not one of the DIALECTS`);
    }
}
export function previewTable (credentialId, dialect, table, database) {
    const body = {
        query: PREVIEW_QUERY(dialect, table, database)
    };
    return apiThunk(
        `query/${credentialId}`,
        'POST',
        'previewTableRequest',
        [credentialId, table],
        body
    );
}

export function initializeTabs() {
    return function(dispatch, getState) {
        const state = getState();
        const {credentialsRequest} = state;
        if (credentialsRequest.status !== 200) {
            console.error(
                "Can't initialize tabs - crednetials haven't been retreived yet."
            );
            return;
        }
        const savedCredentials = credentialsRequest.content;
        if (savedCredentials.length > 0) {
            const tabs = savedCredentials.map(() => uuid.v4());
            const tabMap = {};
            const credentials = {};
            savedCredentials.forEach((cred, i) => {
                tabMap[tabs[i]] = cred.id;
                credentials[tabs[i]] = cred;
            });
            dispatch(mergeTabMap(tabMap));
            dispatch(mergeCredentials(credentials));
            dispatch(setTab(tabs[0]));
            savedCredentials.forEach(cred => {
                dispatch(connect(cred.id));
            });
        } else {
            dispatch(newTab());
        }
    };
}

export function newTab() {
    return function(dispatch, getState) {
        const newId = uuid.v4();
        dispatch(mergeCredentials({
            [newId]: {
                username: '',
                password: '',
                database: '',
                dialect: DIALECTS.MYSQL,
                port: '',
                host: '',
                ssl: false
            }
        }));
        dispatch(setTab(newId));
    };
}

export function deleteTab(tabId) {
    return function (dispatch, getState) {
        // TODO - Make a delete request to delete the request from the disk.
        // TODO - Check if any persistent connections depend on this before deleting
        //        and warn the user if so.
        if (tabId === getState().selectedTab) {
            const tabIds = Object.keys(getState().credentials);
            const currentIdIndex = tabIds.indexOf(tabId);
            let nextIdIndex;
            if (currentIdIndex === 0) {
                if (tabIds.length > 1) {
                    nextIdIndex = 1;
                } else {
                    nextIdIndex = -1; // null out
                }
            } else {
                nextIdIndex = currentIdIndex - 1;
            }
            dispatch(setTab(tabIds[nextIdIndex]));
        }
        dispatch(deleteCredential(tabId));
    };
}
