import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.createCatalogFx = context => createNode(context, processor);
