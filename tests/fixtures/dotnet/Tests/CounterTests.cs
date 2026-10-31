using Xunit;
public class CounterTests
{
    [Fact] public void StartsAtZero() => Assert.Equal(0, new Blazor.Counter().Count);
    [Fact] public void IncrementAddsOne() { var c = new Blazor.Counter(); c.Increment(); Assert.Equal(1, c.Count); }
}
