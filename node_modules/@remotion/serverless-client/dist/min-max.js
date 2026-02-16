"use strict";
// Standard library Math.min and Math.max can throw
// if array length is very long. Fixing this with own implementation
Object.defineProperty(exports, "__esModule", { value: true });
exports.max = exports.min = void 0;
const min = (arr) => {
    if (arr.length === 0) {
        throw new Error('Array of 0 length');
    }
    let smallest = arr[0];
    for (let i = 0; i < arr.length; i++) {
        const elem = arr[i];
        if (elem < smallest) {
            smallest = elem;
        }
    }
    return smallest;
};
exports.min = min;
const max = (arr) => {
    if (arr.length === 0) {
        throw new Error('Array of 0 length');
    }
    let biggest = arr[0];
    for (let i = 0; i < arr.length; i++) {
        const elem = arr[i];
        if (elem > biggest) {
            biggest = elem;
        }
    }
    return biggest;
};
exports.max = max;
