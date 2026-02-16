"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCustomRoleArn = void 0;
const validateCustomRoleArn = (customRoleArn) => {
    if (typeof customRoleArn !== 'undefined' &&
        typeof customRoleArn !== 'string') {
        throw new TypeError('A custom role ARN must either be "undefined" or a string, but instead got: ' +
            JSON.stringify(customRoleArn));
    }
};
exports.validateCustomRoleArn = validateCustomRoleArn;
