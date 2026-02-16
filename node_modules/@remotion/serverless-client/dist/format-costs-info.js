"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatCostsInfo = void 0;
const display = (accrued) => {
    if (accrued < 0.001) {
        return '<$0.001';
    }
    return new Intl.NumberFormat('en-US', {
        currency: 'USD',
        style: 'currency',
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 3,
    }).format(accrued);
};
const formatCostsInfo = (accrued) => {
    return {
        accruedSoFar: accrued,
        displayCost: display(accrued),
        currency: 'USD',
        disclaimer: 'Estimated cost only. Does not include charges for other AWS services.',
    };
};
exports.formatCostsInfo = formatCostsInfo;
