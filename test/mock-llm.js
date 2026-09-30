'use strict';
// A scripted OpenAI-compatible model for the Podman smoke tests and the e2e gate: it makes the
// agent write /output/report.md, naming the model it was asked for, then /output/findings.json,
// then stops. Streams, as opencode asks. PORT: where to listen (default 8000).

const http = require('node:http');

const steps = (model) => [
  { filePath: '/output/report.md', content: `# Security Report\n\nWritten by model ${model}.\n\nOne Finding: SQL injection in app.js.\n` },
  {
    filePath: '/output/findings.json',
    content: JSON.stringify({
      findings: [
        {
          severity: 'high',
          title: 'SQL injection',
          description: 'The id query parameter is concatenated into SQL.',
          location: { file: 'app.js', line: 4 },
        },
      ],
    }),
  },
];

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const messages = body.messages || [];
      // Caller instructions containing HANG-PROBE keep the Attempt running: no reply ever comes.
      if (JSON.stringify(messages).includes('HANG-PROBE')) return;
      const done = messages.filter((m) => m.role === 'tool').length;
      const tools = (body.tools || []).map((t) => t.function && t.function.name);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const call = (name, args) => {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${done}`, type: 'function', function: { name, arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
        chunk({}, 'tool_calls');
      };
      // Caller instructions containing LEAK-PROBE play a prompt injection: read and search the
      // process environment, which holds the API keys, and copy whatever came back into the Report.
      if (JSON.stringify(messages).includes('LEAK-PROBE')) {
        const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        const results = messages.filter((m) => m.role === 'tool').map(text);
        if (done === 0) call('read', { filePath: '/proc/self/environ' });
        else if (done === 1) call('grep', { pattern: 'canary', path: '/proc/self' });
        else if (done === 2) call('grep', { pattern: 'canary', path: '/proc/1' });
        else if (done === 3) call('write', { filePath: '/output/report.md', content: `leaked: ${results.join('\n---\n')}` });
        else {
          chunk({ role: 'assistant', content: 'Done.' });
          chunk({}, 'stop');
        }
      } else if (steps(body.model)[done] && tools.includes('write')) {
        call('write', steps(body.model)[done]);
      } else {
        chunk({ role: 'assistant', content: 'Done.' });
        chunk({}, 'stop');
      }
      res.end(
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
    });
  })
  .listen(Number(process.env.PORT || 8000));
