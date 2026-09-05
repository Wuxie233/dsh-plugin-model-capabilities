import create from './host.js'

export { default as createHost } from './host.js'

export default {
  activate(context) {
    context.extensions.publish({ apiVersion: 'plugins.starpivot.dev/v1', kind: 'HostPlugin' }, "dev.starpivot.model-capabilities", { create })
  },
}
