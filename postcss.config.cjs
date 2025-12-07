// postcss.config.cjs
const isProd = process.env.NODE_ENV === 'production';

module.exports = {
  plugins: {
    // lets you do @import "file.css"
    'postcss-import': {},
    // CSS nesting like Sass: .a { .b { ... } }
    'postcss-nesting': {},
    // vendor prefixes where needed
    autoprefixer: {},
    // minify only in production
    ...(isProd ? { cssnano: { preset: 'default' } } : {}),
  },
};
