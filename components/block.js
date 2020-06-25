polarity.export = PolarityComponent.extend({
  details: Ember.computed.alias('block.data.details'),
  viewFullRiskHistory: false,
  historyLimit: Ember.computed('block.data.details.total', 'viewFullRiskHistory', function () {
    if (this.get('viewFullRiskHistory')) {
      return this.get('block.data.details.total');
    } else {
      return 10;
    }
  }),
  actions: {
    toggleRiskHistory: function () {
      this.toggleProperty('viewFullRiskHistory');
    }
  }
});
