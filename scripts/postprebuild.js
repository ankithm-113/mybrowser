/**
 * Re-applies local fixes that `expo prebuild` wipes.
 *
 * The android/ directory is generated and gitignored, so anything patched
 * inside it is lost on every prebuild. Rather than rely on remembering, this
 * runs as part of `npm run prebuild`.
 *
 *   node scripts/postprebuild.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let changed = 0;

/**
 * Gradle's wrapper defaults to a 10s network timeout. Fetching the ~230MB
 * distribution redirects twice (services.gradle.org -> github.com ->
 * release-assets) and routinely exceeds that, leaving a 0-byte .part file and
 * a download that can never succeed on retry.
 */
function patchGradleTimeout() {
  const file = path.join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!fs.existsSync(file)) {
    console.log('skip  gradle-wrapper.properties (no android/ directory — run prebuild first)');
    return;
  }

  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/^networkTimeout=\d+$/m, 'networkTimeout=120000');

  if (after === before) {
    console.log('ok    gradle networkTimeout already 120000');
    return;
  }
  fs.writeFileSync(file, after);
  changed++;
  console.log('fixed gradle networkTimeout -> 120000');
}

patchGradleTimeout();
console.log(changed ? `\n${changed} fix(es) applied.` : '\nNothing to do.');
