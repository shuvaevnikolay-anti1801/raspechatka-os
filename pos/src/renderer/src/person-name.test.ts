import { describe, expect, it } from 'vitest'
import { formatPersonShortName } from './person-name'

describe('formatPersonShortName',()=>{
  it('shows surname with name and patronymic initials',()=>{
    expect(formatPersonShortName('Шуваев Николай Александрович')).toBe('Шуваев Н. А.')
  })

  it('normalizes whitespace and supports a missing patronymic',()=>{
    expect(formatPersonShortName('  Иванова   Анна   Сергеевна  ')).toBe('Иванова А. С.')
    expect(formatPersonShortName('Петров Иван')).toBe('Петров И.')
  })

  it('preserves already short Cyrillic initials and limits extra name parts',()=>{
    expect(formatPersonShortName('  Иванова  А.   С. ')).toBe('Иванова А. С.')
    expect(formatPersonShortName('Петров Иван Сергеевич Дополнение')).toBe('Петров И. С.')
    expect(formatPersonShortName(' Петров   И. ')).toBe('Петров И.')
  })

  it('keeps a single-part display name and handles an empty value',()=>{
    expect(formatPersonShortName('Администратор')).toBe('Администратор')
    expect(formatPersonShortName(undefined)).toBe('')
  })
})
