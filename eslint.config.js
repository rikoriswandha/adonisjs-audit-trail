import { configPkg } from '@adonisjs/eslint-config'

export default configPkg({
  files: ['src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
  },
})
