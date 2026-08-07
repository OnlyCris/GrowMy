'use server';

import type {
  CreateKeywordInput,
  GenerateArticleInput,
  GenerateKeywordsInput,
  ReviewKeywordInput,
} from '@growmy/validation';

import * as keywords from './keywords.impl';

export async function addKeywordAction(input: CreateKeywordInput) {
  return keywords.addKeyword(input);
}

export async function generateArticleFromKeywordAction(input: GenerateArticleInput) {
  return keywords.generateArticleFromKeyword(input);
}

export async function generateKeywordsAction(input: GenerateKeywordsInput) {
  return keywords.generateKeywords(input);
}

export async function reviewKeywordAction(input: ReviewKeywordInput) {
  return keywords.reviewKeyword(input);
}
