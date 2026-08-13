// Parse-checks the main inline <script> block in index.html without executing it.
// Catches syntax errors (stray braces, unclosed strings, etc.) before deploy.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(filePath, 'utf8');

const openTag = '<script>';
const closeTag = '</script>';
const start = html.indexOf(openTag);
if (start === -1) {
  console.error('Could not find an inline <script> tag in index.html');
  process.exit(1);
}
const contentStart = start + openTag.length;
const end = html.indexOf(closeTag, contentStart);
if (end === -1) {
  console.error('Could not find a matching </script> tag in index.html');
  process.exit(1);
}

const script = html.slice(contentStart, end);

try {
  // eslint-disable-next-line no-new-func
  new Function(script);
  console.log(`index.html inline script: syntax OK (${script.split('\n').length} lines)`);
} catch (err) {
  console.error('index.html inline script has a syntax error:');
  console.error(err.message);
  process.exit(1);
}
