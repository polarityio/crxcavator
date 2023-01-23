'use strict';

const request = require('postman-request');
const config = require('./config/config');
const _ = require('lodash');
const async = require('async');
const fs = require('fs');

let Logger;
let requestWithDefaults;

const MAX_PARALLEL_LOOKUPS = 10;
const MAX_RESULTS_TO_RETURN = 10;

function startup(logger) {
  let defaults = {};
  Logger = logger;

  const { cert, key, passphrase, ca, proxy, rejectUnauthorized } = config.request;

  if (typeof cert === 'string' && cert.length > 0) {
    defaults.cert = fs.readFileSync(cert);
  }

  if (typeof key === 'string' && key.length > 0) {
    defaults.key = fs.readFileSync(key);
  }

  if (typeof passphrase === 'string' && passphrase.length > 0) {
    defaults.passphrase = passphrase;
  }

  if (typeof ca === 'string' && ca.length > 0) {
    defaults.ca = fs.readFileSync(ca);
  }

  if (typeof proxy === 'string' && proxy.length > 0) {
    defaults.proxy = proxy;
  }

  if (typeof rejectUnauthorized === 'boolean') {
    defaults.rejectUnauthorized = rejectUnauthorized;
  }

  requestWithDefaults = request.defaults(defaults);
}

function doLookup(entities, options, cb) {
  let lookupResults = [];
  let tasks = [];

  Logger.debug(entities);
  entities.forEach((entity) => {
    let requestOptions = {
      method: 'GET',
      headers: {
        'API-Key': options.apiKey
      },
      uri: `${options.url}/report/${entity.value}`,
      json: true
    };

    Logger.trace({ requestOptions }, 'Request Options');

    tasks.push(function (done) {
      requestWithDefaults(requestOptions, function (error, res, body) {
        Logger.trace({ body, status: res ? res.statusCode : 'N/A' }, 'HTTP Request Results');
        let processedResult = handleRestError(error, entity, res, body);

        if (processedResult.error) {
          done(processedResult);
          return;
        }

        done(null, processedResult);
      });
    });
  });

  async.parallelLimit(tasks, MAX_PARALLEL_LOOKUPS, (err, results) => {
    if (err) {
      Logger.error({ err: err }, 'Error');
      cb(err);
      return;
    }

    results.forEach((result) => {
      if (result.body === null || result.body.length === 0) {
        lookupResults.push({
          entity: result.entity,
          data: null
        });
      } else {
        const sortedResults = sortResultsByVersion(result.body);
        const { minRisk, maxRisk, recentRisk, riskTable, keyExtensions } = findMinMaxRisk(sortedResults);
        Logger.info(sortedResults);
        lookupResults.push({
          entity: result.entity,
          data: {
            summary: [
              `Latest Risk: ${recentRisk}`,
              `Max Risk: ${maxRisk}`,
              `Min Risk: ${minRisk}`,
              `# of Versions: ${result.body.length}`
            ],
            details: {
              total: result.body.length,
              maxRisk,
              riskTable,
              extensions: reduceResultData(keyExtensions)
            }
          }
        });
      }
    });

    Logger.debug({ lookupResults }, 'Results');
    cb(null, lookupResults);
  });
}

function sortResultsByVersion(results) {
  return results.sort((extA, extB) => {
    const dateA = _.get(extA, 'data.webstore.last_updated', 0);
    const dateB = _.get(extB, 'data.webstore.last_updated', 0);
    return new Date(dateB) - new Date(dateA);
  });
}

function findMinMaxRisk(results) {
  let maxRisk = -1;
  let recentRisk = -1;
  let minRisk = Number.MAX_SAFE_INTEGER;
  let maxRiskExtension = null;
  let minRiskExtension = null;
  let mostRecentExtension = null;
  let keyExtensions = [];

  let riskTable = [];

  for (let i = 0; i < results.length; i++) {
    const ext = results[i];
    const riskTotal = _.get(ext, 'data.risk.total', 'N/A');
    const lastUpdated = _.get(ext, 'data.webstore.last_updated', 'N/A');

    if (i === 0) {
      mostRecentExtension = ext;
      recentRisk = riskTotal;
    }

    riskTable.push({
      version: ext.version,
      riskTotal,
      lastUpdated,
      extensionId: ext.extension_id
    });
    if (riskTotal > maxRisk) {
      maxRisk = riskTotal;
      maxRiskExtension = ext;
    }
    if (riskTotal < minRisk) {
      minRisk = riskTotal;
      minRiskExtension = ext;
    }
  }

  riskTable.forEach((row) => {
    row.riskPercentage = (row.riskTotal / maxRisk) * 100;
  });

  minRiskExtension.__title = 'Minimum Risk Version';
  minRiskExtension.__icon = 'temperature-down';
  maxRiskExtension.__title = 'Maximum Risk Version';
  maxRiskExtension.__icon = 'temperature-up';
  mostRecentExtension.__title = 'Most Recent Version';
  mostRecentExtension.__icon = 'info';

  keyExtensions.push(mostRecentExtension);

  if (
    minRiskExtension.version === maxRiskExtension.version &&
    minRiskExtension.version === mostRecentExtension.version
  ) {
    mostRecentExtension.__title = 'Most Recent & Max Risk Version';
  } else {
    if (mostRecentExtension.version === maxRiskExtension.version) {
      mostRecentExtension.__title = 'Most Recent & Max Risk Version';
    } else {
      // most recent is not the same as max
      keyExtensions.push(maxRiskExtension);
    }

    if (minRiskExtension.version === mostRecentExtension.version) {
      mostRecentExtension.__title = 'Most Recent & Minimum Risk Version';
    } else {
      keyExtensions.push(minRiskExtension);
    }
  }

  return {
    maxRisk,
    minRisk,
    recentRisk,
    keyExtensions,
    riskTable
  };
}

function reduceResultData(results) {
  let reducedResults = [];
  for (let i = 0; i < results.length && i < MAX_RESULTS_TO_RETURN; i++) {
    reducedResults.push(_.pick(results[i], ['__title', '__icon', 'version', 'extension_id', 'data.risk', 'data.webstore']));
  }
  return reducedResults;
}

function handleRestError(error, entity, res, body) {
  let result;

  if (error) {
    return {
      error: error,
      detail: 'HTTP Request Error'
    };
  }

  if (res.statusCode === 200 && Array.isArray(body) && body.length > 0) {
    // we got data!
    result = {
      entity: entity,
      body: body
    };
  } else if (res.statusCode === 200) {
    result = {
      entity: entity,
      body: null
    };
  } else if (res.statusCode === 400) {
    result = {
      error: 'Bad Request',
      detail: body.query_status
    };
  } else if (res.statusCode === 401) {
    result = {
      error: 'Unauthorized',
      detail: body.query_status
    };
  } else if (res.statusCode === 404) {
    result = {
      error: 'Not Found',
      detail: body.query_status
    };
  } else {
    result = {
      error: 'Unexpected Error',
      statusCode: res ? res.statusCode : 'Unknown',
      detail: 'An unexpected error occurred'
    };
  }

  return result;
}

function validateOption(errors, options, optionName, errMessage) {
  if (
    typeof options[optionName].value !== 'string' ||
    (typeof options[optionName].value === 'string' && options[optionName].value.length === 0)
  ) {
    errors.push({
      key: optionName,
      message: errMessage
    });
  }
}

function validateOptions(options, callback) {
  let errors = [];

  validateOption(errors, options, 'url', 'You must provide a valid URL.');
  validateOption(errors, options, 'apiKey', 'You must provide a valid API Key.');

  callback(null, errors);
}

module.exports = {
  doLookup: doLookup,
  validateOptions: validateOptions,
  startup: startup
};
