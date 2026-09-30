'use strict';
// A scripted OpenAI-compatible model for the Podman smoke tests: it makes the agent write
// /output/report.md, then /output/findings.json, then stops. Streams, as opencode asks.
// PORT: where to listen (default 8000).

const http = require('node:http');

const STEPS = [
  { filePath: '/output/report.md', content: '# Security Report\n\nOne Finding: SQL injection in app.js.\n' },
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
      const done = (body.messages || []).filter((m) => m.role === 'tool').length;
      const tools = (body.tools || []).map((t) => t.function && t.function.name);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const step = STEPS[done];
      if (step && tools.includes('write')) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${done}`, type: 'function', function: { name: 'write', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step) } }] });
        chunk({}, 'tool_calls');
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
