/*
 * JavaScript functions for providing OpenID Connect with NGINX Plus
 * 
 * Copyright (C) 2020 Nginx, Inc.
 */
var newSession = false; // Used by oidcAuth() and validateIdToken()

const EXTRA_PARAMS = 1;
const REPLACE_PARAMS = 2;
const WRN_SESSION_COOKIE = 'OIDC session cookie is invalid';
const INF_SESSION_COOKIE = 'OIDC session cookie is valid';

export default {
    auth,
    codeExchange,
    validateIdToken,
    logout,
    redirectPostLogin,
    redirectPostLogout,
    userInfo,
    validateSessionCookie
};

function retryOriginalRequest(r) {
    delete r.headersOut["WWW-Authenticate"]; // Remove evidence of original failed auth_jwt
    r.internalRedirect(r.variables.uri + r.variables.is_args + (r.variables.args || ''));
}

// If the ID token has not been synced yet, poll the variable every 100ms until
// get a value or after a timeout.
function waitForSessionSync(r, timeLeft) {
    if (r.variables.session_jwt) {
        retryOriginalRequest(r);
    } else if (timeLeft > 0) {
        setTimeout(waitForSessionSync, 100, r, timeLeft - 100);
    } else {
        auth(r, true);
    }
}

function auth(r, afterSyncCheck) {
    // If a cookie was sent but the ID token is not in the key-value database, wait for the token to be in sync.
    if (r.variables.cookie_session_id && !r.variables.session_jwt && !afterSyncCheck && r.variables.zone_sync_leeway > 0) {
        waitForSessionSync(r, r.variables.zone_sync_leeway);
        return;
    }

    if (!r.variables.refresh_token || r.variables.refresh_token == "-" || !isValidSessionCookie(r)) {
        newSession = true;

        // Check we have all necessary configuration variables (referenced only by njs)
        var oidcConfigurables = ["authz_endpoint", "scopes", "hmac_key", "cookie_flags"];
        var missingConfig = [];
        for (var i in oidcConfigurables) {
            if (!r.variables["oidc_" + oidcConfigurables[i]] || r.variables["oidc_" + oidcConfigurables[i]] == "") {
                missingConfig.push(oidcConfigurables[i]);
            }
        }
        if (missingConfig.length) {
            r.error("OIDC missing configuration variables: $oidc_" + missingConfig.join(" $oidc_"));
            r.return(500, r.variables.internal_error_message);
            return;
        }
        // Redirect the client to the IdP login page with the cookies we need for state
        r.return(302, r.variables.oidc_authz_endpoint + getQueryParamsAuthZ(r));
        return;
    }
    
    // Pass the refresh token to the /_refresh location so that it can be
    // proxied to the IdP in exchange for a new id_token
    r.subrequest("/_refresh", "token=" + r.variables.refresh_token,
        function(reply) {
            if (reply.status != 200) {
                // Refresh request failed, log the reason
                var error_log = "OIDC refresh failure";
                if (reply.status == 504) {
                    error_log += ", timeout waiting for IdP";
                } else if (reply.status == 400) {
                    try {
                        var errorset = JSON.parse(reply.responseBody);
                        error_log += ": " + errorset.error + " " + errorset.error_description;
                    } catch (e) {
                        error_log += ": " + reply.responseBody;
                    }
                } else {
                    error_log += " "  + reply.status;
                }
                r.error(error_log);

                // Clear the refresh token, try again
                r.variables.refresh_token = "-";
                r.return(302, r.variables.request_uri);
                return;
            }

            // Refresh request returned 200, check response
            try {
                var tokenset = JSON.parse(reply.responseBody);
                if (!tokenset.id_token) {
                    r.error("OIDC refresh response did not include id_token");
                    if (tokenset.error) {
                        r.error("OIDC " + tokenset.error + " " + tokenset.error_description);
                    }
                    r.variables.refresh_token = "-";
                    r.return(302, r.variables.request_uri);
                    return;
                }

                // Send the new ID Token to auth_jwt location for validation
                r.subrequest("/_id_token_validation", "token=" + tokenset.id_token,
                    function(reply) {
                        if (reply.status != 204) {
                            r.variables.refresh_token = "-";
                            r.return(302, r.variables.request_uri);
                            return;
                        }

                        // ID Token is valid, update keyval
                        r.variables.session_id = r.variables.cookie_session_id;
                        r.log("OIDC refresh success, updating id_token for " + r.variables.cookie_session_id);
                        r.variables.session_jwt = tokenset.id_token; // Update key-value store
                        if (tokenset.access_token) {
                            r.variables.access_token = tokenset.access_token;
                        } else {
                            r.variables.access_token = "-";
                        }

                        // Update refresh token (if we got a new one)
                        if (r.variables.refresh_token != tokenset.refresh_token) {
                            r.log("OIDC replacing previous refresh token (" + r.variables.refresh_token + ") with new value: " + tokenset.refresh_token);
                            r.variables.refresh_token = tokenset.refresh_token; // Update key-value store
                        }

                        retryOriginalRequest(r); // Continue processing original request
                    }
                );
            } catch (e) {
                r.variables.refresh_token = "-";
                r.return(302, r.variables.request_uri);
                return;
            }
        }
    );
}

function codeExchange(r) {
    // First check that we received an authorization code from the IdP
    if (r.variables.arg_code == undefined || r.variables.arg_code.length == 0) {
        if (r.variables.arg_error) {
            r.error("OIDC error receiving authorization code from IdP: " + r.variables.arg_error_description);
        } else {
            r.error("OIDC expected authorization code from IdP but received: " + r.uri);
        }
        r.return(502);
        return;
    }

    // Pass the authorization code to the /_token location so that it can be
    // proxied to the IdP in exchange for a JWT
    r.subrequest("/_token",idpClientAuth(r), function(reply) {
            if (reply.status == 504) {
                r.error("OIDC timeout connecting to IdP when sending authorization code");
                r.return(504);
                return;
            }

            if (reply.status != 200) {
                try {
                    var errorset = JSON.parse(reply.responseBody);
                    if (errorset.error) {
                        r.error("OIDC error from IdP when sending authorization code: " + errorset.error + ", " + errorset.error_description);
                    } else {
                        r.error("OIDC unexpected response from IdP when sending authorization code (HTTP " + reply.status + "). " + reply.responseBody);
                    }
                } catch (e) {
                    r.error("OIDC unexpected response from IdP when sending authorization code (HTTP " + reply.status + "). " + reply.responseBody);
                }
                r.return(502);
                return;
            }

            // Code exchange returned 200, check for errors
            try {
                var tokenset = JSON.parse(reply.responseBody);
                if (tokenset.error) {
                    r.error("OIDC " + tokenset.error + " " + tokenset.error_description);
                    r.return(500);
                    return;
                }

                // Send the ID Token to auth_jwt location for validation
                r.subrequest("/_id_token_validation", "token=" + tokenset.id_token,
                    function(reply) {
                        if (reply.status != 204) {
                            r.return(500); // validateIdToken() will log errors
                            return;
                        }

                        // If the response includes a refresh token then store it
                        if (tokenset.refresh_token) {
                            r.variables.new_refresh = tokenset.refresh_token; // Create key-value store entry
                            r.log("OIDC refresh token stored");
                        } else {
                            r.warn("OIDC no refresh token");
                        }

                        // Add opaque token to keyval session store
                        r.log("OIDC success, creating session " + r.variables.session_id);
                        r.variables.session_id = generateSessionID(r)
                        r.variables.new_session = tokenset.id_token; // Create key-value store entry
                        if (tokenset.access_token) {
                            r.variables.new_access_token = tokenset.access_token;
                        } else {
                            r.variables.new_access_token = "-";
                        }
                        
                        r.headersOut["Set-Cookie"] = "session_id=" + r.variables.session_id + "; " + r.variables.oidc_cookie_flags;
                        r.return(302, r.variables.redirect_base + r.variables.cookie_auth_redir);
                   }
                );
            } catch (e) {
                r.error("OIDC authorization code sent but token response is not JSON. " + reply.responseBody);
                r.return(502);
            }
        }
    );
}

function validateIdToken(r) {
    // Check mandatory claims
    var required_claims = ["iat", "iss", "sub"]; // aud is checked separately
    var missing_claims = [];
    for (var i in required_claims) {
        if (r.variables["jwt_claim_" + required_claims[i]].length == 0 ) {
            missing_claims.push(required_claims[i]);
        }
    }
    if (r.variables.jwt_audience.length == 0) missing_claims.push("aud");
    if (missing_claims.length) {
        r.error("OIDC ID Token validation error: missing claim(s) " + missing_claims.join(" "));
        r.return(403);
        return;
    }
    var validToken = true;

    // Check iat is a positive integer
    var iat = Math.floor(Number(r.variables.jwt_claim_iat));
    if (String(iat) != r.variables.jwt_claim_iat || iat < 1) {
        r.error("OIDC ID Token validation error: iat claim is not a valid number");
        validToken = false;
    }

    // Audience matching
    var aud = r.variables.jwt_audience.split(",");
    if (!aud.includes(r.variables.oidc_client)) {
        r.error("OIDC ID Token validation error: aud claim (" + r.variables.jwt_audience + ") does not include configured $oidc_client (" + r.variables.oidc_client + ")");
        validToken = false;
    }

    // If we receive a nonce in the ID Token then we will use the auth_nonce cookies
    // to check that the JWT can be validated as being directly related to the
    // original request by this client. This mitigates against token replay attacks.
    if (newSession) {
        var client_nonce_hash = "";
        if (r.variables.cookie_auth_nonce) {
            var c = require('crypto');
            var h = c.createHmac('sha256', r.variables.oidc_hmac_key).update(r.variables.cookie_auth_nonce);
            client_nonce_hash = h.digest('base64url');
        }
        if (r.variables.jwt_claim_nonce != client_nonce_hash) {
            r.error("OIDC ID Token validation error: nonce from token (" + r.variables.jwt_claim_nonce + ") does not match client (" + client_nonce_hash + ")");
            validToken = false;
        }
    }

    if (validToken) {
        r.return(204);
    } else {
        r.return(403);
    }
}

//
// Default RP-Initiated or Custom Logout w/ OP.
// 
// - An RP requests that the OP log out the end-user by redirecting the
//   end-user's User Agent to the OP's Logout endpoint.
// - https://openid.net/specs/openid-connect-rpinitiated-1_0.html#RPLogout
// - https://openid.net/specs/openid-connect-rpinitiated-1_0.html#RedirectionAfterLogout
//
function logout(r) {
    r.log("OIDC logout for " + r.variables.cookie_session_id);
    var idToken = r.variables.session_jwt;
    var queryParams = '?post_logout_redirect_uri=' + 
                      r.variables.redirect_base + 
                      r.variables.oidc_logout_redirect +
                      '&id_token_hint=' + idToken;
    if (r.variables.oidc_logout_query_params_option == REPLACE_PARAMS) {
        queryParams = '?' + r.variables.oidc_logout_query_params;
    } else if (r.variables.oidc_logout_query_params_option == EXTRA_PARAMS) {
        queryParams += '&' + r.variables.oidc_logout_query_params;
    } 
    r.variables.session_id    = '-';
    r.variables.session_jwt   = '-';
    r.variables.access_token  = '-';
    r.variables.refresh_token = '-';
    r.return(302, r.variables.oidc_logout_endpoint + queryParams);
}

function getQueryParamsAuthZ(r) {
    // Choose a nonce for this flow for the client, and hash it for the IdP
    var noncePlain = r.variables.session_id;
    var c = require('crypto');
    var h = c.createHmac('sha256', r.variables.oidc_hmac_key).update(noncePlain);
    var nonceHash = h.digest('base64url');
    var queryParams = "?response_type=code&scope=" + r.variables.oidc_scopes + "&client_id=" + r.variables.oidc_client + "&redirect_uri="+ r.variables.redirect_base + r.variables.redir_location + "&nonce=" + nonceHash;

    r.variables.nonce_hash = nonceHash;
    r.headersOut['Set-Cookie'] = [
        "auth_redir=" + r.variables.request_uri + "; " + r.variables.oidc_cookie_flags,
        "auth_nonce=" + noncePlain + "; " + r.variables.oidc_cookie_flags
    ];

    if ( r.variables.oidc_pkce_enable == 1 ) {
        var pkce_code_verifier = c.createHmac('sha256', r.variables.oidc_hmac_key).update(String(Math.random())).digest('hex');
        r.variables.pkce_id = c.createHash('sha256').update(String(Math.random())).digest('base64url');
        var pkce_code_challenge = c.createHash('sha256').update(pkce_code_verifier).digest('base64url');
        r.variables.pkce_code_verifier = pkce_code_verifier;
        r.variables.pkce_code_challenge = pkce_code_challenge;

        queryParams += "&code_challenge_method=S256&code_challenge=" + pkce_code_challenge + "&state=" + r.variables.pkce_id;
    } else {
        queryParams += "&state=0";
    }
    if (r.variables.oidc_authz_query_params_option == REPLACE_PARAMS) {
        queryParams = '?' + r.variables.oidc_authz_query_params;
    } else if (r.variables.oidc_authz_query_params_option == EXTRA_PARAMS) {
        queryParams += '&' + r.variables.oidc_authz_query_params;
    }
    return queryParams;
}

function idpClientAuth(r) {
    // If PKCE is enabled we have to use the code_verifier
    if ( r.variables.oidc_pkce_enable == 1 ) {
        r.variables.pkce_id = r.variables.arg_state;
        return "code=" + r.variables.arg_code + "&code_verifier=" + r.variables.pkce_code_verifier;
    } else {
        return "code=" + r.variables.arg_code + "&client_secret=" + r.variables.oidc_client_secret;
    }   
}

//
// Redirect URI after successful login from the OP.
//
function redirectPostLogin(r) {
    if (r.variables.oidc_landing_page) {
        r.return(302, r.variables.oidc_landing_page);
    } else {
        r.return(302, r.variables.redirect_base + r.variables.cookie_auth_redir);
    }
}

//
// Redirect URI after logged-out from the OP.
//
function redirectPostLogout(r) {
    if (r.variables.post_logout_return_uri) {
        r.return(302, r.variables.post_logout_return_uri);
    } else {
        r.return(302, r.variables.redirect_base + r.variables.cookie_auth_redir);
    }
}

//
// Return necessary user info claims after receiving and extracting all claims
// that are received from the OpenID Connect Provider(OP).
//
function userInfo(r) {
    r.subrequest('/_userinfo',
        function(res) {
            if (res.status == 200) {
                var error_log = "OIDC userinfo JSON failure";
                var claimsOP = ''; // Claims that are received by the OP.
                try {
                    claimsOP = JSON.parse(res.responseBody);
                } catch (e) {
                    error_log += ": " + res.responseBody;
                    r.error(error_log);
                    r.return(500);
                    return;
                }
                // The claimsRP is to extract claims that are configured in
                // $oidc_userinfo_required_claims in the RP and send them to
                // the client using the response of the OP.
                var claimsRP = r.variables.oidc_userinfo_required_claims.split(",");
                var ret = {};
                for (var i in claimsRP) {
                    if (claimsRP[i] in claimsOP) {
                        ret[claimsRP[i]] = claimsOP[claimsRP[i]];
                    }
                }
                r.variables.user_info = JSON.stringify(ret);
                r.return(200, r.variables.user_info);
            } else {
                r.return(res.status)
            }
        }
    );
}

// Generate session ID using remote address, user agent, client ID, and time.
function generateSessionID(r) {
    var time = new Date(Date.now());
    var jsonSession = {
        'remoteAddr': r.variables.remote_addr,
        'userAgent' : r.variables.http_user_agent,
        'clientID'  : r.variables.oidc_client,
        'date'      : time.getDate()
    };
    if (r.variables.session_cookie_validation_time_format == "hh") {
        jsonSession['timestamp'] = time.getHours() + ":00";
    } else if (r.variables.session_cookie_validation_time_format == "mm") {
        jsonSession['timestamp'] = time.getHours() + ":" + time.getMinutes();
    }
    var data = JSON.stringify(jsonSession);
    var c = require('crypto');
    var h = c.createHmac('sha256', r.variables.oidc_hmac_key).update(data);
    var session_id = h.digest('base64url');
    return session_id;
}

// Check if session cookie is valid, and generate new session id otherwise.
function isValidSessionCookie(r) {
    if (r.variables.session_cookie_validation_enable == 0) {
        return true;
    }
    r.log('Start checking if there is an existing valid session...')
    var valid_session_id = generateSessionID(r);
    if (r.variables.cookie_session_id != valid_session_id) {
        return false;
    }
    return true;
}

// Check if the session cookie is valid to mitigate security issues where
// anyone who holds the session cookie could access backend from any client
// (browsers or command line).
function validateSessionCookie(r) {
    if (!isValidSessionCookie(r)) {
        r.warn(WRN_SESSION_COOKIE)
        r.return(403, '{"message": "' + WRN_SESSION_COOKIE + '"}\n')
        return false;
    }
    r.return(200, '{"message": "' + INF_SESSION_COOKIE + '"}\n') 
    return true;
}
