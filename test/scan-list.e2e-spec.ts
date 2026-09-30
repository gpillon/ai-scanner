import { MINUTE_MS } from '../src/config/app-config';
import { Gate, Harness, scripts, startApp } from './harness';

describe('GET /api/scans', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startApp();
  });
  afterEach(() => h.dispose());

  it('is empty before any Scan', async () => {
    const res = await h.api.get('/api/scans');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists every Scan newest first, as GET /api/scan/<id> shows each', async () => {
    const gate = new Gate();
    h.runner.script = scripts.perAttempt(gate.script());
    await h.submit('first');
    h.clock.advance(MINUTE_MS);
    await h.submit('second', { profile: 'security', model: 'deep-model' });
    gate.release('first');
    await h.waitForState('first', 'succeeded');
    await h.waitForState('second', 'running');

    const res = await h.api.get('/api/scans');
    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id)).toEqual(['second', 'first']);
    for (const scan of res.body) {
      expect(scan).toEqual((await h.api.get(`/api/scan/${scan.id}`)).body);
    }
    expect(res.body[0]).toMatchObject({ state: 'running', model: 'deep-model' });
    expect(res.body[1]).toMatchObject({ state: 'succeeded', artifacts: expect.arrayContaining(['report.md']) });

    gate.release('second');
    await h.waitForState('second', 'succeeded');
  });

  it('no longer lists a deleted Scan', async () => {
    await h.submit('gone');
    await h.waitForState('gone', 'succeeded');
    await h.submit('kept');
    await h.waitForState('kept', 'succeeded');
    expect((await h.api.delete('/api/scan/gone')).status).toBe(204);

    const res = await h.api.get('/api/scans');
    expect(res.body.map((s: { id: string }) => s.id)).toEqual(['kept']);
  });
});
