const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = require('../../raspechatka/public/js/os-update-password.js');

test('key and validation', () => {
	assert.equal(api.resetKey('?key=once&password_expired=true'), 'once');
	assert.equal(api.resetKey(''), '');
	assert.equal(api.validate('', 'Strong-123!', 'Strong-123!', false).message, 'Введите текущий пароль');
	assert.equal(api.validate('', '', '', true).field, 'new');
	assert.equal(api.validate('', 'short', 'short', true).field, 'new');
	assert.equal(api.validate('', 'Strong-123!', 'Mismatch', true).field, 'confirm');
	assert.equal(api.validate('Strong-123!', 'Strong-123!', 'Strong-123!', false).field, 'new');
	assert.equal(api.validate('', 'Strong-123!', 'Strong-123!', true), null);
});

test('redirect rejects external and control characters', () => {
	for (const value of ['//evil.test', '/\\evil.test', 'https://evil.test', '/\nevil', null]) {
		assert.equal(api.safeRedirect(value), '/raspechatka');
	}
	assert.equal(api.safeRedirect('/raspechatka/orders'), '/raspechatka/orders');
});

test('public errors never interpolate server details', () => {
	const raw = { message: 'English secret', _server_messages: 'traceback', exc_type: 'InvalidResetKey' };
	assert.match(api.publicError(410, raw, true), /Ссылка недействительна/);
	assert.match(api.publicError(401, raw, false), /Текущий пароль/);
	assert.match(api.publicError(429, raw, true), /Слишком много/);
	assert.match(api.publicError(400, { exc_type: 'PasswordPolicyError', message: 'secret' }, true), /требованиям/);
	assert.match(api.publicError(417, { exc_type: 'ValidationError', message: '<div>common password</div>' }, true), /требованиям/);
	assert.doesNotMatch(api.publicError(500, raw, false), /secret|traceback/);
});
