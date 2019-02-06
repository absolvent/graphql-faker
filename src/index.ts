#!/usr/bin/env node

import 'core-js/shim';

import {
  Source,
  parse,
  concatAST,
  buildASTSchema,
} from 'graphql';

import * as fs from 'fs';
import * as path from 'path';
import * as express from 'express';
import * as graphqlHTTP from 'express-graphql';
import chalk from 'chalk';
import * as opn from 'opn';
import * as cors from 'cors';
import * as bodyParser from 'body-parser';
import {pick} from 'lodash';
import * as yargs from 'yargs';

import {fakeSchema} from './fake_schema';
import {existsSync} from './utils';

const DEFAULT_SCHEMA_DIR = 'schemas';

const argv = yargs
  .command('$0', '', cmd => cmd.options({
    'ENABLE_EDIT_MODE': {
      alias: 'E',
      describe: 'Enable editing schema',
      type: 'boolean',
      default: true,
    },
    'port': {
      alias: 'p',
      describe: 'HTTP Port',
      type: 'number',
      requiresArg: true,
      default: process.env.PORT || 9002,
    },
    'open': {
      alias: 'o',
      describe: 'Open page with IDL editor and GraphiQL in browser',
      type: 'boolean',
    },
    'cors-origin': {
      alias: 'co',
      describe: 'CORS: Specify the custom origin for the Access-Control-Allow-Origin header, by default it is the same as `Origin` header from the request',
      type: 'string',
      requiresArg: true,
    },
  }))
  .strict()
  .help('h')
  .alias('h', 'help')
  .epilog(`Examples:

  # Mock GraphQL API based on example IDL and open interactive editor
  $0 --open

  # Extend real data from SWAPI with faked data based on extension IDL
  $0 ./ext-swapi.grqphql --extend http://swapi.apis.guru/

  # Extend real data from GitHub API with faked data based on extension IDL
  $0 ./ext-gh.graphql --extend https://api.github.com/graphql \\
  --header "Authorization: bearer <TOKEN>"`)
  .argv


const log = console.log;

const ENV_ENABLE_EDIT_MODE = process.env.ENABLE_EDIT_MODE;
const ENABLE_EDIT_MODE = ENV_ENABLE_EDIT_MODE !== undefined ? parseBoolean(ENV_ENABLE_EDIT_MODE) : argv.ENABLE_EDIT_MODE;

log(chalk.magenta(`ENABLE_EDIT_MODE=${ENABLE_EDIT_MODE}`));

let headers = {};
if (argv.header) {
  const headerStrings = Array.isArray(argv.header) ? argv.header : [argv.header];
  for (const str of headerStrings) {
    const index = str.indexOf(':');
    const name = str.substr(0, index).toLowerCase();
    const value = str.substr(index + 1).trim();
    headers[name] = value;
  }
}

const forwardHeaderNames = (argv.forwardHeaders || []).map(
  str => str.toLowerCase()
);

const fileName = argv.file || (argv.extend ?
  './schema_extension.faker.graphql' :
  './schema.faker.graphql');


if (!argv.file) {
  log(chalk.yellow(`Default file ${chalk.magenta(fileName)} is used. ` +
    `Specify [file] parameter to change.`));
}

const fakeDefinitionAST = readAST(path.join(__dirname, 'fake_definition.graphql'));
const corsOptions = {}

corsOptions['credentials'] = true
corsOptions['origin'] = argv.co ? argv.co : true;

function parseBoolean(value) {
  return !(value.toLowerCase() === 'false' || value === '0' || value.toLowerCase() === 'no');
}

function readIDL(filePath) {
  if (existsSync(filePath)) {
    return new Source(
      fs.readFileSync(filePath, 'utf-8'),
      filePath
    );
  }
  return null;
}

function getFilePathForSchema(schemaName) {
  const fileName = schemaName ? `${schemaName}.graphql` : 'default.graphql';
  return path.resolve(__dirname, DEFAULT_SCHEMA_DIR, fileName);
}

function readAST(filepath) {
  return parse(readIDL(filepath));
}

function saveIDL(idl, fileName) {
  fs.writeFileSync(fileName, idl);
  log(`${chalk.green('✚')} schema saved to ${chalk.magenta(fileName)} on ${(new Date()).toLocaleString()}`);
  return new Source(idl, fileName);
}

runServer(schema => {
  fakeSchema(schema)
  return {schema};
});

function buildServerSchema(idl) {
  let ast = concatAST([parse(idl), fakeDefinitionAST]);
  return buildASTSchema(ast);
}

function runServer(optionsCB) {
  const app = express();

  app.options('/graphql/:schemaName?', cors(corsOptions))
  app.use('/graphql/:schemaName?', cors(corsOptions), graphqlHTTP(req => {
    const schemaName = req.params.schemaName;
    const schemaIDL = readIDL(getFilePathForSchema(schemaName));
    const schema = buildServerSchema(schemaIDL);
    const forwardHeaders = pick(req.headers, forwardHeaderNames);
    return {
      ...optionsCB(schema, forwardHeaders),
      graphiql: true,
    };
  }));

  app.get('/user-idl/:schemaName?', (req, res) => {
    const schemaName = req.params.schemaName;
    const filename = getFilePathForSchema(schemaName);
    const schemaIDL = readIDL(filename);
    if (schemaIDL) {
      if (ENABLE_EDIT_MODE) {
        res.status(200).json({
          schemaIDL: schemaIDL.body,
        });
      } else {
        res.status(200).json({
          schemaIDL: schemaIDL.body,
          editMode: false,
        });
      }

    } else {
      res.status(404).json({
        error: `Schema "${schemaName}" not found...`,
      });
    }
  });

  app.use('/user-idl/:schemaName?', bodyParser.text({limit: '20mb'}));

  app.post('/user-idl/:schemaName?', (req, res) => {
    const schemaName = req.params.schemaName;
    const schemaFileName = getFilePathForSchema(schemaName);
    try {
      if (ENABLE_EDIT_MODE) {
        saveIDL(req.body, schemaFileName);
        res.status(200).send('ok');
      } else {
        res.status(400).send('Schema not editable. ENABLE_EDIT_MODE is false');
      }
    } catch (err) {
      res.status(500).send(err.message)
    }
  });

  app.use(express.static(path.join(__dirname, 'editor'), {redirect: false}));

  app.get('/editor/:schemaName?', (_, res) => {
    res.sendFile(path.join(path.join(__dirname, 'editor') + '/index.html'));
  });

  const server = app.listen(argv.port);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`\n${chalk.green('✔')} Your GraphQL Fake API is ready to use 🚀
  Here are your links:

  ${chalk.blue('❯')} Interactive Editor:\t http://localhost:${argv.port}/editor
  ${chalk.blue('❯')} GraphQL API:\t http://localhost:${argv.port}/graphql

  `);

  if (argv.open) {
    setTimeout(() => opn(`http://localhost:${argv.port}/editor`), 500);
  }
}
