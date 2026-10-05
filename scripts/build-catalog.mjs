import {buildConsumer} from './build-consumer.mjs';
const {output}=buildConsumer({fixture:'tests/catalog-audition-consumer',stageSite:true});
console.log(`Built packed catalog audition: ${output}`);
