import http from 'node:http';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

interface StoredMail {
  id: number;
  receivedAt: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; size: number }[];
}

const MAX_MAILS = 5000;
const mails: StoredMail[] = [];
let seq = 0;

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    simpleParser(stream)
      .then((parsed) => {
        const to = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [];
        mails.unshift({
          id: ++seq,
          receivedAt: new Date().toISOString(),
          from: parsed.from?.text ?? '',
          to: to.flatMap((a) => a.value.map((v) => v.address ?? '')),
          subject: parsed.subject ?? '',
          text: parsed.text ?? '',
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename ?? 'attachment',
            size: a.size,
          })),
        });
        if (mails.length > MAX_MAILS) mails.length = MAX_MAILS;
        callback();
      })
      .catch((err: Error) => callback(err));
  },
});
smtp.on('error', (err) => console.error('smtp error', err));
smtp.listen(Number(process.env['SMTP_PORT'] ?? 1025), '0.0.0.0');

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const web = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  } else if (url.pathname === '/api/messages') {
    const to = url.searchParams.get('to');
    const list = to ? mails.filter((m) => m.to.includes(to)) : mails;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  } else if (url.pathname === '/') {
    const rows = mails
      .map(
        (m) =>
          `<tr><td>${m.id}</td><td>${esc(m.receivedAt)}</td><td>${esc(m.to.join(', '))}</td>` +
          `<td>${esc(m.subject)}</td><td><pre>${esc(m.text.slice(0, 500))}</pre></td>` +
          `<td>${m.attachments.length}</td></tr>`,
      )
      .join('');
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        `<!doctype html><meta charset="utf-8"><title>Mail stub</title><h1>Mail stub (${mails.length})</h1>` +
          `<table border="1" cellpadding="4"><tr><th>#</th><th>Received</th><th>To</th><th>Subject</th><th>Text</th><th>Att.</th></tr>${rows}</table>`,
      );
  } else {
    res.writeHead(404).end();
  }
});
web.listen(Number(process.env['HTTP_PORT'] ?? 8025), '0.0.0.0');

const stop = (): void => {
  smtp.close(() => web.close(() => process.exit(0)));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
