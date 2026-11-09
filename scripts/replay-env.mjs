// Environment for the child processes of the headless replay run.
//
// Anything that could leave the loopback or change the plugin's behavior is
// removed first; the redirect variables are added last so they cannot be lost.
const REMOVED = ['OPENCODE_API_KEY', 'DSH_OPENCODE_FREE_DEBUG', 'DEBUG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']

export function childEnv(base, { home, redirect } = {}) {
  const env = { ...base }
  for (const name of REMOVED) delete env[name]
  env.DSH_HOME = home
  if (redirect !== undefined) {
    env.NODE_EXTRA_CA_CERTS = redirect.ca
    env.NODE_OPTIONS = `--require ${redirect.preload}`
    env.REPLAY_FAKE_PORT = String(redirect.port)
  }
  return env
}
