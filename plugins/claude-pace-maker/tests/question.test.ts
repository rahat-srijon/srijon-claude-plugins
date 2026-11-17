import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsWithQuestion } from '../hooks/lib/question.ts';

test('a plain question is detected', () => {
  assert.equal(endsWithQuestion('Which one do you want?'), true);
  assert.equal(endsWithQuestion('Which one do you want?\n'), true);
  assert.equal(endsWithQuestion('Ready to proceed? (yes/no)?'), true);
});

test('trailing quotes, parens, emphasis, punctuation and emoji are ignored', () => {
  assert.equal(endsWithQuestion('Should I continue?"'), true);
  assert.equal(endsWithQuestion('Should I continue?)'), true);
  assert.equal(endsWithQuestion('(Should I continue?)'), true);
  assert.equal(endsWithQuestion('**Should I continue?**'), true);
  assert.equal(endsWithQuestion('Should I continue?!'), true);
  assert.equal(endsWithQuestion('Should I continue? \u{1F642}'), true);
  assert.equal(endsWithQuestion('Should I continue?」'), true);
});

test('the fullwidth question mark counts', () => {
  assert.equal(endsWithQuestion('続けますか？'), true);
});

test('no question mark is false', () => {
  assert.equal(endsWithQuestion('All done.'), false);
  assert.equal(endsWithQuestion('Let me know which one you prefer.'), false);
  assert.equal(endsWithQuestion(''), false);
  assert.equal(endsWithQuestion('   \n\n  '), false);
});

test('a question mark that is not last is false', () => {
  assert.equal(endsWithQuestion('Is that right? I will assume yes.'), false);
});

test('a URL with a question mark is not a question', () => {
  assert.equal(endsWithQuestion('See https://example.com/page?id=1'), false);
  assert.equal(endsWithQuestion('Docs: (https://example.com/?q=1)'), false);
  assert.equal(endsWithQuestion('Is it at https://example.com/a?'), false);
});

test('a question mark inside inline code is not a question', () => {
  assert.equal(endsWithQuestion('Try the regex `a?`'), false);
  assert.equal(endsWithQuestion('Use `x?.y`'), false);
  assert.equal(endsWithQuestion('Should I use `a?`?'), true);
  assert.equal(endsWithQuestion('Should I run `npm test`?'), true);
});

test('an answer ending inside an open code fence is false', () => {
  assert.equal(endsWithQuestion('Here:\n```js\nconst a = b ? 1 : 2?'), false);
  assert.equal(endsWithQuestion('Here:\n```js\nconst a = 1;\n```\nSo, ok?'), true);
});

test('a list item or table row ending in ? is false', () => {
  assert.equal(endsWithQuestion('Options:\n- Do you want A?\n- Do you want B?'), false);
  assert.equal(endsWithQuestion('Questions:\n1. Why?\n2. When?'), false);
  assert.equal(endsWithQuestion('| q |\n| --- |\n| Why? |'), false);
  assert.equal(endsWithQuestion('Intro\n* Which?'), false);
});

test('a last paragraph over 300 characters is false', () => {
  assert.equal(endsWithQuestion(`${'word '.repeat(70)}really?`), false);
  assert.equal(endsWithQuestion(`${'a'.repeat(298)}?`), true);
});

test('only the last paragraph counts', () => {
  assert.equal(endsWithQuestion('Any thoughts?\n\nI will carry on now.'), false);
  assert.equal(endsWithQuestion('I changed three files.\n\nShould I commit them?'), true);
  assert.equal(endsWithQuestion('Intro\n\n\n\nWhich branch?\n\n  \n'), true);
});

test('non-string input is false', () => {
  assert.equal(endsWithQuestion(undefined as unknown as string), false);
});
