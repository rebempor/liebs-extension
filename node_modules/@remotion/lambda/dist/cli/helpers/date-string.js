"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dateString = void 0;
const dateString = (date) => date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0');
exports.dateString = dateString;
