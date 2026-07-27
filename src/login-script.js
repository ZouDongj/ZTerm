// ZTerm - Login Script Processor (adapted from Tabby loginScriptProcessing)
// Intercepts SSH session output, matches against user-defined Expect/Send rules,
// and auto-responds to automate login flows (e.g. sudo password, init commands).

class LoginScriptProcessor {
    constructor(scripts) {
        // Deep-clone to avoid mutating the caller's array
        this._scripts = scripts ? scripts.map(s => ({ ...s })) : [];
        this._escapeSeqMap = {
            a: '\x07', b: '\x08', e: '\x1b', f: '\x0c',
            n: '\x0a', r: '\x0d', t: '\x09', v: '\x0b',
        };
        // Pre-process escape sequences once
        for (const script of this._scripts) {
            if (!script.isRegex && script.expect) {
                script._expect = this._unescape(script.expect);
            } else {
                script._expect = script.expect || '';
            }
            script._send = this._unescape(script.send || '');
        }
    }

    // Process a chunk of terminal output.
    // Returns { send: string } if a script matched and should be sent,
    // or null if no script matched.
    feed(dataString) {
        if (this._scripts.length === 0) return null;

        for (const script of this._scripts) {
            // Empty expect = unconditional, handled by executeUnconditional()
            if (!script.expect && !script._expect) {
                continue;
            }

            let match = false;
            if (script.isRegex) {
                try {
                    const re = new RegExp(script._expect, 'g');
                    match = re.test(dataString);
                } catch (e) {
                    // Invalid regex — skip this script to avoid infinite blocking
                    this._scripts = this._scripts.filter(x => x !== script);
                    continue;
                }
            } else {
                match = dataString.includes(script._expect);
            }

            if (match) {
                this._scripts = this._scripts.filter(x => x !== script);
                return { send: script._send };
            } else {
                if (script.optional) {
                    // Skip optional scripts that don't match — don't block the queue
                    this._scripts = this._scripts.filter(x => x !== script);
                    continue;
                } else {
                    // Non-optional didn't match — stop processing until more data arrives
                    break;
                }
            }
        }
        return null;
    }

    // Execute scripts with empty expect immediately after shell opens.
    // Returns array of send strings to write to the channel.
    executeUnconditional() {
        const result = [];
        for (const script of this._scripts) {
            if (!script.expect) {
                result.push(script._send);
                this._scripts = this._scripts.filter(x => x !== script);
            } else {
                break; // stop at first conditional script
            }
        }
        return result;
    }

    get remaining() {
        return this._scripts.length;
    }

    // Unescape Tabby-style escape sequences: \n \t \r \xHH \uHHHH
    _unescape(line) {
        if (!line) return '';
        // Handle \xHH and \uHHHH (hex/unicode escapes)
        line = line.replace(/\\((?:x([0-9a-fA-F]{2}))|(?:u([0-9a-fA-F]{4})))/g,
            (_, hex2, uni4) => {
                return String.fromCharCode(parseInt(hex2 || uni4, 16));
            });
        // Handle simple escape sequences
        return line.replace(/\\(.)/g, (_, ch) => {
            return this._escapeSeqMap[ch] || ch;
        });
    }
}

module.exports = { LoginScriptProcessor };
