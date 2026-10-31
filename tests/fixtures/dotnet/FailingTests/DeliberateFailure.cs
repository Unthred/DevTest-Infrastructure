using Xunit;
public class DeliberateFailure
{
    [Fact] public void Passes() => Assert.True(true);
    [Fact] public void Fails() => Assert.Equal(2, 1 + 2);
}
