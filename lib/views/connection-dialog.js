/**
 * The "connect to GitLab" form.
 *
 * It does three things the old packages did not:
 *   - tells you, before you type anything, whether your machine can store the
 *     token safely, and which store it would use;
 *   - offers the token sources that mean you never paste a token at all
 *     (an environment variable, or the GitLab CLI you already logged into);
 *   - tests the connection and reports the two failures separately - a bad URL
 *     and a bad token are different problems with different fixes.
 */

const secrets = require('../secrets');
const { GitLabClient } = require('../gitlab/client');
const { normaliseBaseUrl } = require('../connections');

function el (tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function field (labelText, control, hintText) {
  const wrapper = el('div', 'gl-field');
  const label = el('label', 'gl-field-label', labelText);
  wrapper.appendChild(label);
  wrapper.appendChild(control);
  if (hintText) wrapper.appendChild(el('div', 'gl-field-hint text-subtle', hintText));
  return wrapper;
}

function input (placeholder, value = '') {
  const node = document.createElement('input');
  node.type = 'text';
  node.className = 'input-text native-key-bindings';
  node.placeholder = placeholder;
  node.value = value;
  return node;
}

function select (options, value) {
  const node = document.createElement('select');
  node.className = 'input-select';
  for (const [optionValue, label] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    node.appendChild(option);
  }
  if (value) node.value = value;
  return node;
}

class ConnectionDialog {
  /**
   * @param {object} options
   * @param {string} [options.host] - prefill, when we know the repo's host
   * @param {object} [options.existing] - a connection to edit
   */
  constructor ({ host = null, existing = null } = {}) {
    this.existing = existing;
    this.resolve = null;
    this.build(host, existing);
  }

  build (host, existing) {
    this.element = el('div', 'gitlab-connection-dialog');
    this.element.appendChild(el('h2', null, existing ? 'Edit GitLab connection' : 'Connect to GitLab'));

    const suggestedUrl = existing ? existing.baseUrl : (host ? `https://${host}` : 'https://gitlab.com');
    this.urlInput = input('https://gitlab.com', suggestedUrl);
    this.element.appendChild(field('GitLab URL', this.urlInput,
      'The address you open in a browser. Works for gitlab.com and for an instance on your own network.'));

    this.nameInput = input('A short name for this connection', existing ? existing.name : (host || ''));
    this.element.appendChild(field('Name', this.nameInput,
      'How this instance is labelled in the panel. Leave blank to use the hostname.'));

    // Token storage - say what the machine can actually do before asking.
    const backend = secrets.keyringBackendName();
    const keyringOk = secrets.keyringAvailable();
    const sourceOptions = [
      ['keyring', keyringOk ? `Store it encrypted (${backend})` : 'Store it encrypted (not available here)'],
      ['env', 'Read it from an environment variable'],
      ['glab', 'Use the token from the GitLab CLI (glab)'],
      ['plain', 'Store it unencrypted (not recommended)']
    ];
    this.sourceSelect = select(sourceOptions, keyringOk ? 'keyring' : 'env');
    if (!keyringOk) this.sourceSelect.querySelector('option[value="keyring"]').disabled = true;
    const unavailableReason = secrets.keyringUnavailableReason();
    this.element.appendChild(field('Where the token lives', this.sourceSelect,
      keyringOk
        ? `Encrypted with a key held by your desktop keyring (${backend}). Never written to config.cson.`
        : `Encrypted storage is off: ${unavailableReason || 'no desktop keyring is available.'} An environment variable or the GitLab CLI keeps the token out of a file entirely.`));

    this.tokenInput = input('glpat-...');
    this.tokenInput.type = 'password';
    this.tokenField = field('Personal access token', this.tokenInput,
      'Create one at GitLab > Preferences > Access tokens. Choose "api" to run pipelines, or "read_api" to only look.');
    this.element.appendChild(this.tokenField);

    this.envInput = input('GITLAB_TOKEN', 'GITLAB_TOKEN');
    this.envField = field('Environment variable', this.envInput,
      'Pulsar only sees variables that were set before it started. If you launch it from a desktop icon, it will not see your shell exports.');
    this.element.appendChild(this.envField);

    this.scopeSelect = select([
      ['api', 'api - view and control pipelines'],
      ['read_api', 'read_api - view only']
    ], existing ? existing.scope : 'api');
    this.element.appendChild(field('Token scope', this.scopeSelect,
      'GitLab has no scope between the two. Running, retrying or cancelling anything needs "api".'));

    // TLS - only worth showing for a self-hosted instance.
    this.tlsDetails = document.createElement('details');
    this.tlsDetails.className = 'gl-tls';
    const summary = el('summary', null, 'Certificates (self-hosted instances)');
    this.tlsDetails.appendChild(summary);

    this.caInput = input('/etc/ssl/certs/my-company-ca.pem', existing && existing.tls ? existing.tls.caPath || '' : '');
    this.tlsDetails.appendChild(field('Certificate authority file', this.caInput,
      'Point this at the CA that signed your GitLab certificate. This is the right fix for a private or self-signed certificate.'));

    this.fingerprintInput = input('sha256 fingerprint', existing && existing.tls ? existing.tls.fingerprint || '' : '');
    this.tlsDetails.appendChild(field('Or pin the certificate fingerprint', this.fingerprintInput,
      'Get it with: openssl s_client -connect your-gitlab:443 | openssl x509 -noout -fingerprint -sha256'));

    this.insecureCheckbox = document.createElement('input');
    this.insecureCheckbox.type = 'checkbox';
    this.insecureCheckbox.className = 'input-checkbox';
    this.insecureCheckbox.checked = Boolean(existing && existing.tls && existing.tls.rejectUnauthorized === false);
    const insecureLabel = el('label', 'gl-checkbox-label');
    insecureLabel.appendChild(this.insecureCheckbox);
    insecureLabel.appendChild(document.createTextNode(' Skip certificate checking for this connection'));
    const insecureWrap = el('div', 'gl-field');
    insecureWrap.appendChild(insecureLabel);
    insecureWrap.appendChild(el('div', 'gl-field-hint text-error',
      'Anyone on the network who can answer for this hostname then gets your token, which is your whole GitLab account. Use the CA file instead unless you are testing.'));
    this.tlsDetails.appendChild(insecureWrap);
    this.element.appendChild(this.tlsDetails);

    this.resultEl = el('div', 'gl-dialog-result');
    this.element.appendChild(this.resultEl);

    const buttons = el('div', 'gl-dialog-buttons');
    this.testButton = el('button', 'btn', 'Test connection');
    this.testButton.addEventListener('click', () => this.test());
    this.saveButton = el('button', 'btn btn-primary', existing ? 'Save' : 'Connect');
    this.saveButton.addEventListener('click', () => this.submit());
    const cancelButton = el('button', 'btn', 'Cancel');
    cancelButton.addEventListener('click', () => this.close(null));
    buttons.appendChild(cancelButton);
    buttons.appendChild(this.testButton);
    buttons.appendChild(this.saveButton);
    this.element.appendChild(buttons);

    this.sourceSelect.addEventListener('change', () => this.syncSourceFields());
    this.syncSourceFields();

    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close(null);
      if (event.key === 'Enter' && event.target !== this.testButton) this.submit();
    });
  }

  syncSourceFields () {
    const source = this.sourceSelect.value;
    this.tokenField.style.display = (source === 'keyring' || source === 'plain') ? '' : 'none';
    this.envField.style.display = source === 'env' ? '' : 'none';
  }

  values () {
    const tls = {};
    if (this.caInput.value.trim()) tls.caPath = this.caInput.value.trim();
    if (this.fingerprintInput.value.trim()) tls.fingerprint = this.fingerprintInput.value.trim();
    if (this.insecureCheckbox.checked) tls.rejectUnauthorized = false;

    return {
      baseUrl: this.urlInput.value.trim(),
      name: this.nameInput.value.trim(),
      tokenSource: this.sourceSelect.value,
      token: this.tokenInput.value,
      envVar: this.envInput.value.trim() || 'GITLAB_TOKEN',
      scope: this.scopeSelect.value,
      tls
    };
  }

  setResult (kind, text) {
    this.resultEl.className = `gl-dialog-result gl-dialog-result-${kind}`;
    this.resultEl.textContent = text;
  }

  /**
   * Try the connection for real before saving it. Two calls, because they fail
   * differently: /version answers even without a valid token, so if that works
   * and /user does not, the URL is right and the token is wrong.
   */
  async test () {
    const values = this.values();
    this.testButton.disabled = true;
    this.setResult('pending', 'Checking...');
    try {
      const baseUrl = normaliseBaseUrl(values.baseUrl);
      const host = new URL(baseUrl).hostname;
      const getToken = async () => {
        if (values.tokenSource === 'env') return secrets.fromEnv(values.envVar);
        if (values.tokenSource === 'glab') return secrets.fromGlab(host);
        return values.token;
      };
      const client = new GitLabClient({ name: values.name || host, baseUrl, scope: values.scope, tls: values.tls }, getToken);
      const { version, user } = await client.checkConnection();
      this.setResult('ok', `Connected to GitLab ${version.version} as ${user.username}.`);
      return true;
    } catch (err) {
      this.setResult('error', secrets.redact(err.message));
      return false;
    } finally {
      this.testButton.disabled = false;
    }
  }

  submit () {
    const values = this.values();
    if (!values.baseUrl) {
      this.setResult('error', 'A GitLab URL is required.');
      return;
    }
    if ((values.tokenSource === 'keyring' || values.tokenSource === 'plain') && !values.token && !this.existing) {
      this.setResult('error', 'A token is required for that storage choice.');
      return;
    }
    this.close(values);
  }

  /** Show the dialog and resolve with the values, or null if cancelled. */
  show () {
    this.panel = atom.workspace.addModalPanel({ item: this.element });
    this.urlInput.focus();
    this.urlInput.select();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  close (values) {
    if (this.panel) {
      this.panel.destroy();
      this.panel = null;
    }
    if (this.resolve) {
      this.resolve(values);
      this.resolve = null;
    }
  }
}

module.exports = { ConnectionDialog };
