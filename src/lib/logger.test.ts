import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger.js';

describe('Logger', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('info writes JSON to stdout', () => {
    const log = new Logger({}, 'info');
    log.info('hello');

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const line = stdoutSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(parsed.timestamp).toBeDefined();
  });

  it('error writes to stderr', () => {
    const log = new Logger({}, 'error');
    log.error('boom');

    expect(stderrSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stderrSpy.mock.calls[0]![0] as string);
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('boom');
  });

  it('respects minimum log level', () => {
    const log = new Logger({}, 'warn');
    log.debug('skip');
    log.info('skip');
    log.warn('yes');

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(parsed.message).toBe('yes');
  });

  it('includes context fields in output', () => {
    const log = new Logger({ requestId: 'req-1', actor: 'admin' }, 'info');
    log.info('action');

    const parsed = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.actor).toBe('admin');
  });

  it('child() inherits and extends context', () => {
    const parent = new Logger({ service: 'api' }, 'info');
    const child = parent.child({ handler: 'modules' });
    child.info('test');

    const parsed = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(parsed.service).toBe('api');
    expect(parsed.handler).toBe('modules');
  });

  it('merges extra data into log entry', () => {
    const log = new Logger({}, 'info');
    log.info('details', { moduleId: 'mod-1', count: 3 });

    const parsed = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(parsed.moduleId).toBe('mod-1');
    expect(parsed.count).toBe(3);
  });
});
