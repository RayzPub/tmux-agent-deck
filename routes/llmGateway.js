const express = require('express');
const router = express.Router();
const llmGatewayService = require('../services/llmGatewayService');

/**
 * ---------------------------------------------------------
 * 1. Anthropic Protocol Handlers
 * ---------------------------------------------------------
 * Standard Anthropic endpoints: POST /v1/messages, /v1/complete, etc.
 */
router.post('/messages', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'anthropic',
    subPath: '/v1/messages'
  });
});

router.post('/complete', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'anthropic',
    subPath: '/v1/complete'
  });
});

router.post('/messages/count_tokens', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'anthropic',
    subPath: '/v1/messages/count_tokens'
  });
});

/**
 * ---------------------------------------------------------
 * 2. OpenAI Compatible Protocol Handlers
 * ---------------------------------------------------------
 * Standard OpenAI endpoints: POST /v1/chat/completions, /v1/models, etc.
 */
router.post('/chat/completions', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'openai',
    subPath: '/chat/completions'
  });
});

router.post('/completions', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'openai',
    subPath: '/completions'
  });
});

router.post('/embeddings', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'openai',
    subPath: '/embeddings'
  });
});

router.get('/models', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'openai',
    subPath: '/models'
  });
});

router.get('/models/:model', (req, res) => {
  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol: 'openai',
    subPath: `/models/${req.params.model}`
  });
});

/**
 * ---------------------------------------------------------
 * 3. Explicit Provider Routing: /v1/:providerId/*
 * e.g. /v1/kimi/messages or /v1/tencent/chat/completions
 * ---------------------------------------------------------
 */
router.all('/:providerId/*path', (req, res, next) => {
  const providerOverride = req.params.providerId;
  const config = llmGatewayService.loadConfig();
  if (config.providers && config.providers[providerOverride]) {
    const rawPath = Array.isArray(req.params.path)
      ? req.params.path.join('/')
      : (req.params.path || '');

    const isAnthropic =
      rawPath.startsWith('messages') ||
      rawPath.startsWith('complete') ||
      !!req.headers['anthropic-version'] ||
      !!req.headers['x-api-key'];

    const protocol = isAnthropic ? 'anthropic' : 'openai';
    const subPath = isAnthropic
      ? (rawPath.startsWith('v1/') ? `/${rawPath}` : `/v1/${rawPath}`)
      : (rawPath.startsWith('/') ? rawPath : `/${rawPath}`);

    return llmGatewayService.forwardRequest({
      req,
      res,
      protocol,
      subPath,
      providerOverride
    });
  }
  return next();
});

/**
 * ---------------------------------------------------------
 * 4. Universal Wildcard Fallback for /v1/*
 * ---------------------------------------------------------
 */
router.all('/*path', (req, res) => {
  const reqPath = Array.isArray(req.params.path)
    ? req.params.path.join('/')
    : (req.params.path || req.path.replace(/^\//, ''));

  const isAnthropic =
    reqPath.startsWith('messages') ||
    reqPath.startsWith('complete') ||
    !!req.headers['anthropic-version'] ||
    !!req.headers['x-api-key'];

  const protocol = isAnthropic ? 'anthropic' : 'openai';
  const subPath = isAnthropic
    ? (reqPath.startsWith('v1/') ? `/${reqPath}` : `/v1/${reqPath}`)
    : (reqPath.startsWith('/') ? reqPath : `/${reqPath}`);

  return llmGatewayService.forwardRequest({
    req,
    res,
    protocol,
    subPath
  });
});

module.exports = router;
