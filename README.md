# AdonisJS package starter kit

> [!note]
> This starter kit targets **AdonisJS v7**

> A boilerplate for creating AdonisJS packages

This repo provides you with a starting point for creating AdonisJS packages. Of course, you can create a package from scratch with your folder structure and workflow. However, using this starter kit can speed up the process, as you have fewer decisions to make.

## Setup

- Clone the repo on your computer, or use `giget` to download this repo without the Git history.
  ```sh
  npx giget@latest gh:adonisjs/pkg-starter-kit
  ```
- Install dependencies.
- Update the `package.json` file and define the `name`, `description`, `keywords`, and `author` properties.
- The repo is configured with an MIT license. Feel free to change that if you are not publishing under the MIT license.

## Folder structure

The starter kit mimics the folder structure of the official packages. Feel free to rename files and folders as per your requirements.

```
├── providers
├── src
├── bin
├── stubs
├── configure.ts
├── index.ts
├── LICENSE.md
├── package.json
├── README.md
├── tsconfig.json
├── tsnode.esm.js
```

- The `configure.ts` file exports the `configure` hook to configure the package using the `node ace configure` command.
- The `index.ts` file is the main entry point of the package.
- The `tsnode.esm.js` file runs TypeScript code using TS-Node + SWC. Please read the code comment in this file to learn more.
- The `bin` directory contains the entry point file to run Japa tests.
- Learn more about [the `providers` directory](./providers/README.md).
- Learn more about [the `src` directory](./src/README.md).
- Learn more about [the `stubs` directory](./stubs/README.md).

### File system naming convention

We use `snake_case` naming conventions for the file system. The rule is enforced using ESLint. However, turn off the rule and use your preferred naming conventions.

## Peer dependencies

The starter kit has a peer dependency on `@adonisjs/core@6`. Since you are creating a package for AdonisJS, you must make it against a specific version of the framework core.

If your package needs Lucid to be functional, you may install `@adonisjs/lucid` as a development dependency and add it to the list of `peerDependencies`.

As a rule of thumb, packages installed in the user application should be part of the `peerDependencies` of your package and not the main dependency.

For example, if you install `@adonisjs/core` as a main dependency, then essentially, you are importing a separate copy of `@adonisjs/core` and not sharing the one from the user application. Here is a great article explaining [peer dependencies](https://blog.bitsrc.io/understanding-peer-dependencies-in-javascript-dbdb4ab5a7be).

## Published files

Instead of publishing your repo's source code to npm, you must cherry-pick files and folders to publish only the required files.

The cherry-picking uses the `files` property inside the `package.json` file. By default, we publish the following files and folders.

```json
{
  "files": [
    "build/src",
    "build/providers",
    "build/stubs",
    "build/index.d.ts",
    "build/index.js",
    "build/configure.d.ts",
    "build/configure.js"
  ]
}
```

If you create additional folders or files, mention them inside the `files` array.

## Exports

[Node.js Subpath exports](https://nodejs.org/api/packages.html#subpath-exports) allows you to define the exports of your package regardless of the folder structure. This starter kit defines the following exports.

```json
{
  "exports": {
    ".": "./build/index.js",
    "./types": "./build/src/types.js"
  }
}
```

- The dot `.` export is the main export.
- The `./types` exports all the types defined inside the `./build/src/types.js` file (the compiled output).

Feel free to change the exports as per your requirements.

## Testing

We use the [Japa test runner](https://japa.dev/). Integration tests run against SQLite, PostgreSQL 16, and MySQL 8 via [testcontainers](https://www.testcontainers.org/).

- `npm run test`: Lint, then run tests with coverage (SQLite only locally).
- `npm run quick:test`: Run tests without linting or coverage.
- `SKIP_DOCKER_TESTS=1 npm run quick:test`: Skip Postgres/MySQL matrix and run SQLite only.
- `BENCH_DB=postgres npm run bench`: Run benchmarks against Postgres (defaults to SQLite).

The GitHub Actions workflow runs unit tests on Ubuntu + Windows and the full DB matrix on Ubuntu.

## Benchmarks

Run benchmarks locally (SQLite by default):

```bash
npm run bench
BENCH_DB=postgres npm run bench
```

Targets:

| Metric                                 | Target           | Observed (SQLite, MBP M1 Pro)         |
| -------------------------------------- | ---------------- | ------------------------------------- |
| Enqueue overhead per `model.save()`    | < 0.2 ms p99     | ~0.075 ms p99                         |
| Flush throughput (Postgres, batch 200) | ≥ 5,000 events/s | run `BENCH_DB=postgres npm run bench` |

## TypeScript workflow

- The starter kit uses [tsc](https://www.typescriptlang.org/docs/handbook/compiler-options.html) for compiling the TypeScript to JavaScript when publishing the package.
- [TS-Node](https://typestrong.org/ts-node/) and [SWC](https://swc.rs/) are used to run tests without compiling the source code.
- The `tsconfig.json` file is extended from [`@adonisjs/tsconfig`](https://github.com/adonisjs/tooling-config/tree/main/packages/typescript-config) and uses the `NodeNext` module system. Meaning the packages are written using ES modules.
