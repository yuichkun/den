import {buildConsumer} from './build-consumer.mjs';
// Standalone integration-only build for local review. Deployments use build:site.
const {output}=buildConsumer({fixture:'tests/integration-consumer',stageSite:true});
console.log(`Built packed integration candidate: ${output}`);
