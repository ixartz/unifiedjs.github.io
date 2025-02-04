var fs = require('fs')
var strip = require('strip-comments')
var unified = require('unified')

var personal = strip(fs.readFileSync('dictionary.txt', 'utf8'))

var naturalLanguage = unified().use([
  require('retext-english'),
  require('retext-preset-wooorm'),
  [require('retext-equality'), {ignore: ['whitespace']}],
  require('retext-passive'),
  [require('retext-profanities'), {sureness: 1}],
  [require('retext-readability'), {age: 18, minWords: 8}],
  [require('retext-simplify'), {ignore: ['function', 'interface', 'maintain']}],
  require('retext-emoji'),
  require('retext-syntax-mentions'),
  require('retext-syntax-urls'),
  [
    require('retext-spell'),
    {dictionary: require('dictionary-en'), personal: personal}
  ]
])

exports.plugins = [
  require('remark-preset-wooorm'),
  require('remark-frontmatter'),
  [require('remark-retext'), naturalLanguage],
  [require('remark-validate-links'), false],
  [require('remark-lint-no-dead-urls'), 'https://unifiedjs.com'],
  [require('remark-lint-first-heading-level'), 2],
  [require('remark-lint-no-html'), false]
]
