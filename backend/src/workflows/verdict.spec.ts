import { parseVerdict } from './verdict.js';

const values = ['ok', 'problemi'];

describe('parseVerdict', () => {
  it('takes the last verdict line and drops it from the text', () => {
    expect(
      parseVerdict(
        'Looks fine.\nVERDETTO: problemi\nMore.\nVERDETTO: ok',
        values,
      ),
    ).toEqual({
      verdict: 'ok',
      text: 'Looks fine.\nVERDETTO: problemi\nMore.',
    });
  });

  it.each([
    '**VERDETTO: OK**',
    '`VERDETTO:` ok',
    '  verdetto :  _ok_.',
    'VERDETTO: **ok**',
  ])('reads %s', (line) => {
    expect(parseVerdict(`Done.\n${line}`, values)).toEqual({
      verdict: 'ok',
      text: 'Done.',
    });
  });

  it('has none without the line, or with a value not allowed', () => {
    expect(parseVerdict('All good', values).verdict).toBeNull();
    expect(parseVerdict('VERDETTO: maybe', values).verdict).toBeNull();
  });
});
