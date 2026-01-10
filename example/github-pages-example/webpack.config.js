const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    mode: isProduction ? 'production' : 'development',
    entry: './src/index.js',
    output: {
      filename: 'bundle.js',
      path: path.resolve(__dirname, 'dist'),
      clean: true
    },
    devServer: {
      static: {
        directory: path.resolve(__dirname, 'dist')
      },
      hot: true,
      port: 3000,
      open: true,
      historyApiFallback: true
    },
    module: {
      rules: [
        {
          test: /\.css$/i,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.(js|jsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env', '@babel/preset-react']
            }
          }
        }
      ],
    },
    resolve: {
      extensions: ['.js', '.jsx'],
      modules: [
        'node_modules',
        path.resolve(__dirname, '../../node_modules'),
        path.resolve(__dirname, '../..')
      ],
      alias: {
        'react': path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom')
      }
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/index.html',
        filename: 'index.html'
      }),
      new CopyPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, '../../README.md'),
            to: 'README.md',
          },
        ],
      }),
    ]
  };
};