import {buildConsumer} from './build-consumer.mjs';
// Candidate-branch entrypoint. Production main keeps build:consumer.
const {output}=buildConsumer({fixture:'tests/integration-consumer',stageSite:true});
console.log(`Built packed integration candidate: ${output}`);
