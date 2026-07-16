"use strict";

// BUG (deliberate): subtraction instead of addition. ARBOR's demo mission is
// to make the test suite green by fixing this.
function sum(a, b) {
  return a - b;
}

module.exports = { sum };
