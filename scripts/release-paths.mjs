// UNC detection requires a path boundary. JSON-escaped separators inside a
// relative path are not the start of a network path. Multiple leading escapes
// also recognize UNC values serialized in JSON or JavaScript string literals.
export const RELEASE_RULES = [
  { id: 'drive-path', re: /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/, why: '盘符绝对路径 → 改用 <cwd> / os.tmpdir() / %USERPROFILE% / ~/.dsh 或相对路径' },
  { id: 'unc-path', re: /(^|[\s"'`(\[{:;=])\\{2,}[A-Za-z0-9._-]+\\+[A-Za-z0-9$._-]+/, why: 'UNC 网络路径 → 改用配置项或占位符' },
  { id: 'posix-home', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//, why: 'POSIX 家目录绝对路径 → 改用 ~ 或占位符' },
  { id: 'personal-user', re: /(^|[^A-Za-z0-9])Users[\\/](?![<%])[A-Za-z0-9._-]+/, why: '写死了用户名 → 改用 <用户> / %USERPROFILE%' },
];
