import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderMessageMarkdown } from './markdown';

test('message Markdown renders semantic blocks, inline formatting and tables', () => {
  const html = renderMessageMarkdown([
    '# Status', '', 'A **bold** and *emphasized* `value`.',
    '', '> A quote', '', '- First', '- Second', '', '1. Ordered',
    '', '```ts', 'const html = "<tag>";', '```',
    '', '| Item | Count |', '| --- | ---: |', '| Tasks | 2 |',
    '', '[Docs](https://example.com/docs?a=1&b=2)',
  ].join('\n'));

  assert.match(html, /<h1>Status<\/h1>/);
  assert.match(html, /<p>A <strong>bold<\/strong> and <em>emphasized<\/em> <code>value<\/code>\.<\/p>/);
  assert.match(html, /<blockquote>\n<p>A quote<\/p>/);
  assert.match(html, /<ul>\n<li>First<\/li>\n<li>Second<\/li>/);
  assert.match(html, /<ol>\n<li>Ordered<\/li>/);
  assert.match(html, /<pre><code class="language-ts">const html = &quot;&lt;tag&gt;&quot;;/);
  assert.match(html, /<table>[\s\S]+<th class="align-right">Count<\/th>[\s\S]+<td class="align-right">2<\/td>/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs\?a=1&amp;b=2">Docs<\/a>/);
  assert.doesNotMatch(html, /\bstyle=/);
});

test('message Markdown cannot emit raw HTML, non-web links or image loads', () => {
  const html = renderMessageMarkdown([
    '<script>alert(1)</script>', '<img src="https://example.com/raw.png" onerror="alert(1)">',
    '<a href="command:agentTeams.start">Start</a>', '',
    '[Command](command:agentTeams.start) [Local](file:///etc/hosts) [Data](data:text/html;base64,QQ==)',
    '[Script](JaVaScRiPt:alert%281%29) [Entity](java&#x73;cript:evil)',
    '[Relative](//example.com/path) [Reference][bad]', '',
    '[bad]: vscode://agent-teams/anything', '', '<javascript:alert(1)>',
    '', '![A & <tag>](https://example.com/markdown.png)',
    '', '![Inline](data:image/png;base64,QQ==)',
  ].join('\n'));

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;a href=&quot;command:agentTeams\.start&quot;&gt;Start&lt;\/a&gt;/);
  assert.match(html, /<p>A &amp; &lt;tag&gt;<\/p>/);
  assert.doesNotMatch(html, /<(?:script|img|a)\b/i);
});
