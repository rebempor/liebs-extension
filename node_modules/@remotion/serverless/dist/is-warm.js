"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWarm = exports.setWarm = void 0;
let warm = false;
const setWarm = () => {
    warm = true;
};
exports.setWarm = setWarm;
const getWarm = () => warm;
exports.getWarm = getWarm;
