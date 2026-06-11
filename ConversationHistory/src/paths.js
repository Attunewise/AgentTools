const path = require('path')
const os = require('os')

const REPO_ROOT = path.resolve(__dirname, '..')
const sharedStateRoot = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
const LOCAL_STATE_DIR = path.resolve(process.env.SESSION_INDEXER_STATE_DIR || path.join(sharedStateRoot(), 'session-indexer', '.session-indexer'))

module.exports = {
  LOCAL_STATE_DIR,
  REPO_ROOT
}
