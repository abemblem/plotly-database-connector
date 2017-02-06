var restify = require('restify');
import * as Datastores from './persistent/datastores/Datastores.js';
import * as fs from 'fs';

import {getQueries, getQuery, deleteQuery} from './persistent/Queries';
import {
    deleteConnectionById,
    editConnectionById,
    getConnectionById,
    getSanitizedConnections,
    getSanitizedConnectionById,
    lookUpConnections,
    saveConnection,
    validateConnection,
    sanitize
} from './persistent/Connections.js';
import QueryScheduler from './persistent/QueryScheduler.js';
import {getSetting, saveSetting} from './settings.js';
import {checkWritePermissions} from './persistent/PlotlyAPI.js';
import {contains, has, isEmpty, merge, pluck} from 'ramda';
import {getCerts, fetchAndSaveCerts, setRenewalJob} from './certificates';
import Logger from './logger';
import fetch from 'node-fetch';

const opn = require('opn');
const HOSTS = '/etc/hosts';

export default class Server {
    constructor(args = {}) {
        this.certs = getCerts();
        /*
         * If server is given a protocol argument, enforce it,
         * otherwise decide which protocol to use
         * depending if there are certificates. This is mainly
         * used in tests.
        */
        const apiVersion = '1.0.0';
        this.apiVersion = apiVersion;
        if (args.protocol === 'HTTP' || isEmpty(this.certs)) {
            this.server = restify.createServer({version: apiVersion});
            this.protocol = 'http';
            this.domain = 'localhost';
            const redirectBaseUrl = `${this.protocol}://${this.domain}:${getSetting('PORT')}`;
            const oauthClientId = 'isFcew9naom2f1khSiMeAtzuOvHXHuLwhPsM7oPt';
            const oauthUrl = (
                'https://plot.ly/o/authorize/?response_type=token&' +
                `client_id=${oauthClientId}&` +
                `redirect_uri=${redirectBaseUrl}/oauth2/callback`
            );
            // We wanna skip fetching certs in cases such as tests.
            if (!args.skipFetchCerts) {
                const users = getSetting('USERS');
                /*
                 * If no USERS in settings we need to go through OAuth before
                 * being able to ask for a certificate from the CA.
                 * Let the app load for a while before launching OAuth
                 * to avoid opening the new tab in the browser without
                 * the attention of the user.
                 */
                if (isEmpty(users)) {
                    // `opn` module opens a tab in the default browser.
                    setTimeout(() => opn(oauthUrl), 10000);
                }
                const checkOauthComplete = setInterval(() => {
                    // TODO: As metnioned in ./certificates, not sure what
                    // the way to go for multiple users should be.
                    if (users[0]) {
                        if (has('username', users[0]) && has('accessToken', users[0])) {
                            fetchAndSaveCerts();
                            clearInterval(checkOauthComplete);
                        }
                    }
                }, 1000);
            }
            const awaitCertsAndStartHTTPS = setInterval(() => {
                if (!isEmpty(getCerts())) {
                    clearInterval(awaitCertsAndStartHTTPS);
                    this.restartWithSSL();
                }
            }, 2000);
        } else if (args.protocol === 'HTTPS' || this.certs) {
            setRenewalJob();
            this.server = restify.createServer(merge({version: apiVersion}, this.certs));
            this.protocol = 'https';
            // TODO: Need to find better names for these or simplify them into one.
            this.domain = getSetting('CONNECTOR_HOST_INFO').host || getSetting('CONNECTOR_HTTPS_DOMAIN');
        } else {
            Logger.log('Failed to start the server.');
        }

        this.queryScheduler = new QueryScheduler();

        this.start = this.start.bind(this);
        this.close = this.close.bind(this);
    }

    restartWithSSL() {
        // saveSetting('PORT', 9595);
        // We have certs, thus we have a user, we can thus close the HTTP server.
        this.close();
        // Reference the new certs into the instance.;
        this.certs = getCerts();
        // Start the interval to renew the certifications in 24 days.
        setRenewalJob();
        // Create a new server and attach it to the class instance.
        this.server = restify.createServer(merge(
            {version: this.apiVersion}, this.certs)
        );
        this.protocol = 'https';
        this.domain = getSetting('CONNECTOR_HOST_INFO').host || getSetting('CONNECTOR_HTTPS_DOMAIN');
        this.start();
    }

    start() {
        const that = this;
        const server = this.server;

        server.port = parseInt(getSetting('PORT'), 10);

        server.use(restify.queryParser());
        server.use(restify.bodyParser({mapParams: true}));
        server.pre(function (request, response, next) {
            Logger.log(`Request: ${request.href()}`, 2);
            next();
        });

        /*
         * CORS doesn't quite work by default in restify,
         * see https://github.com/restify/node-restify/issues/664
         */
        const headers = [
            'authorization',
            'withcredentials',
            'x-requested-with',
            'x-forwarded-for',
            'x-real-ip',
            'x-customheader',
            'user-agent',
            'keep-alive',
            'host',
            'accept',
            'connection',
            'upgrade',
            'content-type',
            'dnt',
            'if-modified-since',
            'cache-control'
        ];
        server.use(restify.CORS({
            origins: getSetting('CORS_ALLOWED_ORIGINS'),
            credentials: false,
            headers: headers
        }));
        headers.forEach(header => restify.CORS.ALLOW_HEADERS.push(header));
        server.opts( /.*/, function (req, res) {
            res.header(
                'Access-Control-Allow-Headers',
                restify.CORS.ALLOW_HEADERS.join( ', ' )
            );
            res.header(
                'Access-Control-Allow-Methods',
                'POST, GET, DELETE, OPTIONS'
            );
            res.send(204);
        });

        /*
         * For some reason restartWithSSL() is triggered twice even if I
         * properly delete the interval that is calling it ... TODO: investigate.
         * For now a workaround is to catch the error when in use.
         * There is nothing else besides the app that starts the server so
         * there should be no real conflict or need to debug other in use
         */
        server.on('error', (e) => {
            if (e.code == 'EADDRINUSE') {
                console.log('The app is already running or your port is busy. ' +
                'If you think the case is the latter, kill the process and ' +
                'make sure the port is free.');
            }
        });
        console.log(`Listening at: ${this.protocol}://${this.domain}:${server.port}`);
        server.listen(server.port);

        server.get(/\/static\/?.*/, restify.serveStatic({
            directory: `${__dirname}/../`
        }));
        server.get(/\/images\/?.*/, restify.serveStatic({
            directory: `${__dirname}/../app/`
        }));

        server.get(/\/oauth2\/callback\/?$/, restify.serveStatic({
            directory: `${__dirname}/../static`,
            file: 'oauth.html'
        }));

        server.post(/\/oauth2\/token\/?$/, function saveOauth(req, res, next) {
            const {access_token} = req.params;
            Logger.log(`Checking token ${access_token} against ${getSetting('PLOTLY_API_URL')}/v2/users/current`);
            fetch(`${getSetting('PLOTLY_API_URL')}/v2/users/current`, {
                headers: {'Authorization': `Bearer ${access_token}`}
            })
            .then(userRes => userRes.json().then(userMeta => {
                if (userRes.status === 200) {
                    const {username} = userMeta;
                    if (!username) {
                        res.json(500, {error: {message: `User was not found at ${getSetting('PLOTLY_API_URL')}`}});
                        return;
                    }
                    const existingUsers = getSetting('USERS');
                    const existingUsernames = pluck('username', existingUsers);
                    let status;
                    if (contains(username, existingUsernames)) {
                        existingUsers[
                            existingUsernames.indexOf(username)
                        ].accessToken = access_token;
                        status = 200;
                    } else {
                        existingUsers.push({username, accessToken: access_token});
                        status = 201;
                    }
                    saveSetting('USERS', existingUsers);
                    res.json(status, {});
                } else {
                    Logger.log(userMeta, 0);
                    res.json(500, {error: {message: `Error ${userRes.status} fetching user`}});
                }
            }))
            .catch(err => {
                Logger.log(err, 0);
                res.json(500, {error: {message: err.message}});
            });
        });

        server.get('/', restify.serveStatic({
            directory: `${__dirname}/../static`,
            file: 'index.html'
        }));

        server.get('/status', function statusHandler(req, res, next) {
            // TODO - Maybe fix up this copy
            res.send('Connector status - running and available for requests.');
        });

        server.get('/ping', function pingHandler(req, res, next) {
            res.json(200, {message: 'pong'});
        });

        // Hidden URL to test uncaught exceptions
        server.post('/_throw', function throwHandler(req, res, next) {
            throw new Error('Yikes - uncaught error');
        });

        // Validate then save connections to a file
        server.post('/connections', function postDatastoresHandler(req, res, next) {
            /*
             * Check if the connection already exists
             * If it does, prevent overwriting so that IDs
             * that might be saved on other servers that refer
             * to this exact same connection doesn't get
             * overwritten.
             * Can update a connection with a `patch` to `/connections/:connectionId`
             */
            const connectionsOnFile = lookUpConnections(
                /*
                 * Remove the password field since the front-end might not
                 * supply a password if it originally loaded up these creds
                 * via `GET /connections`.
                 */
                sanitize(req.params)
            );
            if (connectionsOnFile) {
                res.send(409, {connectionId: connectionsOnFile.id});
                return;
            } else {

                // Check that the connections are valid
                const connectionObject = req.params;
                validateConnection(req.params).then(validation => {
                    if (isEmpty(validation)) {
                        res.json(200, {connectionId: saveConnection(req.params)});
                        return;
                    } else {
                        Logger.log(validation, 2);
                        res.json(400, {error: {message: validation.message}
                        });
                        return;
                    }
                }).catch(err => {
                    Logger.log(err, 2);
                    res.json(400, {error: {message: err.message}
                    });
                });
            }
        });

        // return sanitized connections
        server.get('/connections', function getDatastoresHandler(req, res, next) {
            res.json(200, getSanitizedConnections());
        });

        /*
         * return a single connection by id
         * ids are assigned by the server on connection save
         */
        server.get('/connections/:id', function getDatastoresIdHandler(req, res, next) {
            const connection = getSanitizedConnectionById(req.params.id);
            if (connection) {
                res.json(200, connection);
            } else {
                res.json(404, {});
            }
        });

        server.put('/connections/:id', (req, res, next) => {
            const connectionExists = getSanitizedConnectionById(req.params.id);
            if (!connectionExists) {
                res.json(404, {});
                return;
            }
            // continue knowing that the id exists already
            validateConnection(req.params).then(validation => {
                if (isEmpty(validation)) {
                    res.json(200, editConnectionById(req.params));
                } else {
                    Logger.log(validation, 2);
                    res.json(400, {error: validation.message});
                }
            }).catch(err => {
                Logger.log(err, 2);
                res.json(400, {error: err.message});
            });
        });

        // delete connections
        // TODO - delete all associated queries?
        server.del('/connections/:id', function delDatastoresHandler(req, res, next) {
            if (getSanitizedConnectionById(req.params.id)) {
                deleteConnectionById(req.params.id);
                res.json(200, {});
            } else {
                res.json(404, {});
            }
        });

        /* Connect */
        server.post('/connections/:connectionId/connect', function postConnectHandler(req, res, next) {
            Datastores.connect(getConnectionById(req.params.connectionId))
            .then(() => {
                res.json(200, {});
            });
        });

        /* One-Shot Queries */

        // Make a query and return the results as a grid
        server.post('/connections/:connectionId/query', function postQueryHandler(req, res, next) {
            Datastores.query(
                req.params.query,
                getConnectionById(req.params.connectionId)
            ).then(rows => {
                res.json(200, rows);
                next();
            }).catch(error => {
                res.json(400, {error: {message: error.message}});
            });
        });

        /*
         * Dialect-specific endpoints.
         *
         * The convention here is for the dialect to take the first part of the URL
         * with SQL-like dialects are grouped together as `sql`.
         * Multiple words are separated by hyphens instead of camelCased or
         * underscored.
         */
        server.post('/connections/:connectionId/sql-tables', function tablesHandler(req, res, next) {
            Datastores.tables(
                getConnectionById(req.params.connectionId)
            ).then(tables => {
                res.json(200, tables);
            }).catch(error => {
                res.json(500, {error: {message: error.message}});
            });
        });

        server.post('/connections/:connectionId/s3-keys', function s3KeysHandler(req, res, next) {
            Datastores.files(
                getConnectionById(req.params.connectionId)
            ).then(files => {
                res.json(200, files);
            }).catch(error => {
                res.json(500, {error: {message: error.message}});
            });
        });

        server.post('/connections/:connectionId/apache-drill-storage', function apacheDrillStorageHandler(req, res, next) {
            Datastores.storage(
                getConnectionById(req.params.connectionId)
            ).then(files => {
                res.json(200, files);
            }).catch(error => {
                res.json(500, {error: {message: error.message}});
            });
        });

        server.post('/connections/:connectionId/apache-drill-s3-keys', function apacheDrills3KeysHandler(req, res, next) {
            Datastores.listS3Files(
                getConnectionById(req.params.connectionId)
            ).then(files => {
                res.json(200, files);
            }).catch(error => {
                res.json(500, {error: {message: error.message}});
            });
        });

        server.post('/connections/:connectionId/elasticsearch-mappings', function elasticsearchMappingsHandler(req, res, next) {
            Datastores.elasticsearchMappings(
                getConnectionById(req.params.connectionId)
            ).then(mappings => {
                res.json(200, mappings);
            }).catch(error => {
                res.json(500, {error: {message: error.message}});
            });
        });

        /* Persistent Datastores */

        // return the list of registered queries
        server.get('/queries', function getQueriesHandler(req, res, next) {
            res.json(200, getQueries());
        });

        server.get('/queries/:fid', function getQueriesFidHandler(req, res, next) {
            const query = getQuery(req.params.fid);
            if (query) {
                res.json(200, query);
            } else {
                res.json(404, {});
            }
        });

        // register or overwrite a query
        /*
         * TODO - Updating a query should be a PATCH or PUT under
         * the endpoint `/queries/:fid`
         */
        server.post('/queries', function postQueriesHandler(req, res, next) {
            // Make the query and update the user's grid
            const {fid, uids, query, connectionId, requestor} = req.params;

            // Check that the user has permission to edit the grid

            checkWritePermissions(fid, requestor)
            .then(function nowQueryAndUpdateGrid() {
                return that.queryScheduler.queryAndUpdateGrid(
                    fid, uids, query, connectionId, requestor
                );
            })
            .then(function returnSuccess() {
                let status;
                if (getQuery(req.params.fid)) {
                    // TODO - Technically, this should be
                    // under the endpoint `/queries/:fid`
                    status = 200;
                } else {
                    status = 201;
                }
                that.queryScheduler.scheduleQuery(req.params);
                res.json(status, {});
            })
            .catch(function returnError(error) {
                Logger.log(error, 0);
                res.json(400, {error: {message: error.message}});
            });

        });

        // TODO - This endpoint is untested
        server.get('has-certs', (req, res, next) => {
            if (isEmpty(getCerts())) {
                res.json(200, false);
            } else {
                res.json(200, true);
            }
        });

        // TODO - This endpoint is untested
        server.get('is-url-redirected', (req, res, next) => {
            const contents = fs.readFileSync(HOSTS);
            if (contents.indexOf(getSetting('CONNECTOR_HTTPS_DOMAIN')) > -1) {
                res.json(200, true);
            } else {
                res.json(404, false);
            }
        });

        /* HTTPS Setup */

        // TODO - This endpoint is untested
        server.get('start-temp-https-server', (req, res, next) => {
            // can't install certificates without having visited the https server
            // and can't start a https app without having installed certificates ...
            // so while an http one is up this endpoint starts a https one for the sole
            // purpose of installing certificates into the user's keychain
            // before restarting the app and simply running a single https instance
            try {
                const certs = getCerts();
                if (isEmpty(certs)) {
                    throw new Error('No certs found.');
                }
                const tempServer = restify.createServer(certs);
                tempServer.use(restify.CORS({
                    origins: getSetting('CORS_ALLOWED_ORIGINS'),
                    credentials: false,
                    headers: headers
                }));
                tempServer.listen(getSetting('PORT') + 1); // not to clash with the open http port
                tempServer.opts( /.*/, (req, res) => res.send(204));
                tempServer.get(/\/ssl\/?.*/, restify.serveStatic({
                    directory: `${__dirname}/../`
                }));
                tempServer.get('/status', (req, res) => {
                    if (req.isSecure()) {
                        fs.readFile(
                            `${__dirname}/../ssl/status.html`, 'utf8', function(err, file) {
                            if (err) {
                                res.send(500);
                            }
                            res.write(file);
                            res.end();
                        });
                    } else {
                        res.send(404, false);
                    }
                });
            } catch (err) {
                Logger.log(err, 2);
                res.json(404, false);
            }
            res.json(200, true);
        });

        // delete a query
        server.del('/queries/:fid', function delQueriesHandler(req, res, next) {
            const {fid} = req.params;
            if (getQuery(fid)) {
                deleteQuery(fid);
                /*
                 * NOTE - return 200 instead of 204 here
                 * so that we can respond with an empty body
                 * which makes front-end generic API handlers
                 * a little easier to write
                 */
                res.json(200, {});
            } else {
                res.json(404, {});
            }
        });

        // Transform restify's error messages into our standard error object
        server.on('uncaughtException', function uncaughtExceptionHandler(req, res, route, err) {
            /*
             * TODO - This custom error handler causes an unhandled rejection error
             * "Can't set headers after they are sent" which gets fired after
             * uncaughtException responses.
             * It doesn't seem to affect the actual API responses (they are tested).
             * I haven't been able to track it down succcessfully.
             * It might be related to the CORS OPTIONS requests that get preceed
             * these requests.
             */
            if (err.message.indexOf("Can't set headers after they are sent") === -1) {
                Logger.log(err);
            }
            res.json(500, {
                error: {message: err.message}
            });
        });

    }

    close() {
        this.server.close();
    }
}
