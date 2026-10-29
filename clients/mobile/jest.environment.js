/**
 * jest 환경: 모든 시험의 재시도 횟수를 등록부(`test-retry.json`)로 정한다 (#4708). `jest.config.js` 의 `testEnvironment` 가 이 파일이다.
 *
 * 등록되고 기한 안인 시험만 1회 다시 돈다. **나머지는 결과가 재시도 0 과 같다.** jest-circus 의 재시도(`jest.retryTimes`)는 describe
 * 블록 단위라서 같은 블록의 다른 시험까지 다시 돌리지만, 아래 두 가지로 시험 하나 단위로 좁힌다:
 *
 *   1. 블록이 시작될 때(`run_describe_start`, 재시도 횟수를 읽기 전) 그 블록이 **직접** 가진 시험 중 등록된 것이 있을 때만
 *      `RETRY_TIMES` 를 1 로 둔다. 시험 파일이 부른 `jest.retryTimes(n)` 도 여기서 덮인다.
 *   2. 등록 밖 시험이 재시도로 돌게 되더라도(같은 블록의 등록된 시험 때문에) 결과는 **첫 시도의 실패 그대로**다 — 재시도가 통과해도
 *      초록이 되지 못한다(`test_done`). 그런 시험은 한 번 더 도는 낭비가 있을 뿐이다.
 *
 * jest-circus 29.7 의 내부 약속(`Symbol.for('RETRY_TIMES')` 를 블록 시작 때 읽는다)에 기댄다. jest 를 올리면 `__tests__/retryRegistry.test.ts`
 * 의 실제 러너 시험이 먼저 알려 준다.
 */
'use strict';

const path = require('path');
const {TestEnvironment: NodeEnvironment} = require('jest-environment-node');
const {RETRY_ATTEMPTS, loadRegistry, retriesFor} = require('./jest.retryRegistry');

const RETRY_TIMES = Symbol.for('RETRY_TIMES');
const LOG_ERRORS_BEFORE_RETRY = Symbol.for('LOG_ERRORS_BEFORE_RETRY');
const ROOT_DESCRIBE_BLOCK_NAME = 'ROOT_DESCRIBE_BLOCK';
const FIRST_FAILURE = Symbol('momo.retry.firstFailure');

class RetryRegistryEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.registry = loadRegistry();
    this.file = path
      .relative(config.projectConfig.rootDir, context.testPath)
      .split(path.sep)
      .join('/');
  }

  /** 시험 하나의 등록 id: `<파일> > <describe> > <시험>`. */
  idOf(test) {
    const names = [test.name];
    for (let block = test.parent; block; block = block.parent) {
      if (block.name && block.name !== ROOT_DESCRIBE_BLOCK_NAME) {
        names.unshift(block.name);
      }
    }
    return [this.file, ...names].join(' > ');
  }

  retriesOf(test) {
    return retriesFor(this.registry, this.idOf(test), Date.now());
  }

  async handleTestEvent(event) {
    switch (event.name) {
      case 'run_describe_start': {
        const listed = event.describeBlock.children.some(
          child => child.type === 'test' && this.retriesOf(child) > 0,
        );
        this.global[RETRY_TIMES] = listed ? RETRY_ATTEMPTS : 0;
        this.global[LOG_ERRORS_BEFORE_RETRY] = true;
        break;
      }
      case 'test_retry': {
        const id = this.idOf(event.test);
        const entry = this.registry.entries.find(candidate => candidate.id === id);
        if (entry && this.retriesOf(event.test) > 0) {
          process.stderr.write(`[test-retry] #${entry.issue} ${id} — 첫 시도 실패, 1회 다시 돌려요(~${entry.expires})\n`);
        }
        break;
      }
      case 'test_done': {
        const test = event.test;
        if (this.retriesOf(test) > 0) {
          break;
        }
        if (test[FIRST_FAILURE] !== undefined) {
          // 재시도가 돌았다: 결과는 첫 시도의 실패다.
          test.errors = test[FIRST_FAILURE];
        } else if (test.errors.length > 0) {
          test[FIRST_FAILURE] = test.errors.slice();
        }
        break;
      }
      default:
        break;
    }
  }
}

module.exports = RetryRegistryEnvironment;
