import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderMessageMarkdown } from './markdown';

test('message Markdown renders semantic blocks, inline formatting and tables', () => {
  const longValue = 'abcdefghijklmnopqrstuvwxyz'.repeat(8);
  const html = renderMessageMarkdown([
    '# Status', '', 'A **bold** and *emphasized* `value`.',
    '', '> A quote', '', '- First', '- Second', '', '1. Ordered',
    '', '```ts', 'const html = "<tag>";', longValue, '```',
    '', '| Item | Count |', '| --- | ---: |', `| ${longValue} | 2 |`,
    '', '[Docs](https://example.com/docs?a=1&b=2)',
  ].join('\n'));

  assert.match(html, /<h1>Status<\/h1>/);
  assert.match(html, /<p>A <strong>bold<\/strong> and <em>emphasized<\/em> <code>value<\/code>\.<\/p>/);
  assert.match(html, /<blockquote>\n<p>A quote<\/p>/);
  assert.match(html, /<ul>\n<li>First<\/li>\n<li>Second<\/li>/);
  assert.match(html, /<ol>\n<li>Ordered<\/li>/);
  assert.match(html, /<pre><code class="language-ts">const html = &quot;&lt;tag&gt;&quot;;/);
  assert.match(html, /<div class="table-scroll" role="region" aria-label="Table" tabindex="0">\n<table>[\s\S]+<th class="align-right">Count<\/th>[\s\S]+<td class="align-right">2<\/td>[\s\S]+<\/table>\n<\/div>/);
  assert.ok(html.includes(`${longValue}\n</code></pre>`));
  assert.ok(html.includes(`<td>${longValue}</td>`));
  assert.match(html, /<\/div>\n<p><a href="https:\/\/example\.com\/docs\?a=1&amp;b=2">Docs<\/a><\/p>/);
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

test('only standalone inline-code workspace references become buttons', () => {
  const html = renderMessageMarkdown([
    '`src/app.ts:12:3` `app.ts:30` `https://example.com:12` `../app.ts:12` `src/app.ts:0`',
    '[`app.ts:3`](https://example.com)', '', '```', 'app.ts:5', '```',
  ].join('\n'));
  assert.equal((html.match(/class="workspace-reference"/g) ?? []).length, 2);
  assert.match(html, /<button [^>]+><code>src\/app\.ts:12:3<\/code><\/button>/);
  assert.match(html, /<a href="https:\/\/example\.com"><code>app\.ts:3<\/code><\/a>/);
  assert.match(html, /<pre><code>app\.ts:5\n<\/code><\/pre>/);
});

test('message Markdown highlights room mentions without marking examples or link text', () => {
  const html = renderMessageMarkdown([
    '@all, (@Builder-2) and @lead. @reviewer test@lead.example @lead/sub @lead.example',
    '', '\\@lead and `@all`', '', '> Mention @all', '', '```md', '@lead', '```', '',
    '[Link @all](https://example.com/@lead) ![@all](https://example.com/image.png)',
  ].join('\n'), new Set(['builder-2', 'lead']));
  assert.deepEqual([...html.matchAll(/class="team-mention">([^<]+)</g)].map(([, tag]) => tag),
    ['@all', '@Builder-2', '@lead']);
  assert.match(html, /Link @all<\/a> @all<\/p>/);
  assert.match(html, /<blockquote>\n<p>Mention @all<\/p>/);
});

test('message Markdown does not highlight mentions on indented continuation lines', () => {
  const html = renderMessageMarkdown([
    '@all', '    @all', '',
    '- Item @builder', '    @builder', '  @builder', '',
    '| @all |', '| --- |',
  ].join('\n'), new Set(['builder']));
  assert.match(html, /<span class="team-mention">@all<\/span><br>\n *@all/);
  assert.match(html, /Item <span class="team-mention">@builder<\/span><br>\n *@builder<br>\n<span class="team-mention">@builder<\/span>/);
  assert.match(html, /<th><span class="team-mention">@all<\/span><\/th>/);
});
